const { 
  Client, GatewayIntentBits, EmbedBuilder, ButtonBuilder, ActionRowBuilder, ButtonStyle, InteractionType 
} = require("discord.js");
const fs = require("fs");
const fetch = require("node-fetch");

const configPath = "./config.json";
let config = JSON.parse(fs.readFileSync(configPath, "utf8"));

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const userReplyDeadlines = new Map(); // channelId => deadline timestamp (ms)

// Save config helper
function saveConfig() {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

// Create or fetch ticket panel embed & message
async function createOrFetchPanel() {
  try {
    const channel = await client.channels.fetch(config.ticketPanelChannelId);
    if (!channel) throw new Error("Ticket panel channel not found");

    if (config.ticketPanelMessageId) {
      try {
        const msg = await channel.messages.fetch(config.ticketPanelMessageId);
        return msg;
      } catch {
        // Message deleted or not found, send new one below
      }
    }

    const embed = new EmbedBuilder()
      .setTitle("🎟️ Create a Ticket")
      .setDescription("Click the button below to open a support ticket.")
      .setColor("Blue")
      .setFooter({ text: "Tickets Panel" });

    const button = new ButtonBuilder()
      .setCustomId("create_ticket")
      .setLabel("Open Ticket")
      .setStyle(ButtonStyle.Primary);

    const row = new ActionRowBuilder().addComponents(button);

    const message = await channel.send({ embeds: [embed], components: [row] });
    config.ticketPanelMessageId = message.id;
    saveConfig();

    console.log("[BOT] Ticket panel ready.");
    return message;
  } catch (err) {
    console.error("Error creating/fetching ticket panel:", err);
  }
}

// Create pastebin log and return URL or null if no messages
async function createPastebinLog(messages, ticketChannel) {
  if (messages.length === 0) return null;

  let logText = `Ticket Log - Channel: #${ticketChannel.name}\n\n`;
  messages.forEach(msg => {
    const time = msg.createdAt.toISOString();
    const author = `${msg.author.tag}`;
    logText += `[${time}] ${author}: ${msg.content}\n`;
  });

  const params = new URLSearchParams();
  params.append("api_dev_key", config.pastebinApiKey);
  params.append("api_option", "paste");
  params.append("api_paste_code", logText);
  params.append("api_paste_private", "1");
  params.append("api_paste_name", `Ticket Log - ${ticketChannel.name}`);
  params.append("api_paste_expire_date", "1D");

  try {
    const res = await fetch("https://pastebin.com/api/api_post.php", {
      method: "POST",
      body: params,
    });
    const url = await res.text();

    if (url.startsWith("http")) return url;
    else {
      console.error("Pastebin error:", url);
      return null;
    }
  } catch (e) {
    console.error("Error uploading to Pastebin:", e);
    return null;
  }
}

// Send DM summary when ticket closes
async function dmTicketCreator(ticketChannel, closerUser, pastebinUrl) {
  try {
    const creatorId = ticketChannel.topic;
    if (!creatorId) return;
    const creator = await client.users.fetch(creatorId).catch(() => null);
    if (!creator) return;

    const embed = new EmbedBuilder()
      .setTitle("Your Ticket Has Been Closed")
      .setColor("Red")
      .setDescription(`Your ticket **#${ticketChannel.name}** was closed by **${closerUser.tag}**.`)
      .setTimestamp();

    if (pastebinUrl) {
      embed.addFields({ name: "Ticket Log", value: `[View Log](${pastebinUrl})` });
    }

    await creator.send({ embeds: [embed] });
  } catch (e) {
    console.error("Failed to DM ticket creator:", e);
  }
}

// Handle closing ticket: logs and DM
async function handleTicketClose(ticketChannel, closerUser) {
  try {
    const messages = await ticketChannel.messages.fetch({ limit: 100 });
    const msgsArray = Array.from(messages.values()).sort((a,b) => a.createdTimestamp - b.createdTimestamp);

    const pastebinUrl = await createPastebinLog(msgsArray, ticketChannel);

    await dmTicketCreator(ticketChannel, closerUser, pastebinUrl);

    // Delete the channel after DMing
    await ticketChannel.delete("Ticket closed");

    userReplyDeadlines.delete(ticketChannel.id);
  } catch (e) {
    console.error("Error closing ticket:", e);
  }
}

// Save user reply deadlines for 24h after staff reply
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.channel.name.startsWith("ticket-")) return;

  const member = await message.guild.members.fetch(message.author.id).catch(() => null);
  if (!member) return;

  if (member.roles.cache.has(config.staffRoleId)) {
    // Staff replied, set deadline for user reply within 24h
    userReplyDeadlines.set(message.channel.id, Date.now() + 24 * 60 * 60 * 1000);
  } else {
    // User replied, clear deadline (or reset)
    userReplyDeadlines.delete(message.channel.id);
  }
});

// On bot ready, create or fetch ticket panel
client.once("ready", async () => {
  console.log(`[BOT] Logged in as ${client.user.tag}`);
  await createOrFetchPanel();
});

// Handle button interactions
client.on("interactionCreate", async (interaction) => {
  if (interaction.type !== InteractionType.MessageComponent) return;

  if (interaction.customId === "create_ticket") {
    const guild = interaction.guild;
    const existing = guild.channels.cache.find(c => c.name === `ticket-${interaction.user.id}`);

    if (existing) {
      const embed = new EmbedBuilder()
        .setColor("Yellow")
        .setDescription("You already have an open ticket!");
      return interaction.reply({ embeds: [embed], flags: 64 });
    }

    try {
      const channel = await guild.channels.create({
        name: `ticket-${interaction.user.id}`,
        type: 0, // GUILD_TEXT
        topic: interaction.user.id,
        permissionOverwrites: [
          { id: guild.roles.everyone.id, deny: ["ViewChannel"] },
          { id: interaction.user.id, allow: ["ViewChannel", "SendMessages", "ReadMessageHistory"] },
          { id: config.staffRoleId, allow: ["ViewChannel", "SendMessages", "ReadMessageHistory"] }
        ],
      });

      // Send welcome embed + close button in ticket channel
      const embed = new EmbedBuilder()
        .setTitle("Ticket Created")
        .setDescription(`Hello <@${interaction.user.id}>! A staff member will be with you shortly.`)
        .setColor("Green");

      const closeButton = new ButtonBuilder()
        .setCustomId("close_ticket")
        .setLabel("Close Ticket")
        .setStyle(ButtonStyle.Danger);

      const row = new ActionRowBuilder().addComponents(closeButton);

      await channel.send({ embeds: [embed], components: [row] });

      // Reply ephemeral to user
      const replyEmbed = new EmbedBuilder()
        .setColor("Green")
        .setDescription(`Your ticket has been created: ${channel}`);

      await interaction.reply({ embeds: [replyEmbed], flags: 64 });

      userReplyDeadlines.set(channel.id, Infinity);

    } catch (e) {
      console.error("Error creating ticket channel:", e);
      const errEmbed = new EmbedBuilder()
        .setColor("Red")
        .setDescription("Failed to create ticket.");
      interaction.reply({ embeds: [errEmbed], flags: 64 });
    }
  }

  else if (interaction.customId === "close_ticket") {
    if (!interaction.channel.name.startsWith("ticket-")) {
      return interaction.reply({ content: "This button can only be used inside ticket channels.", flags: 64 });
    }

    const confirmEmbed = new EmbedBuilder()
      .setColor("Orange")
      .setDescription("Closing ticket...");

    await interaction.reply({ embeds: [confirmEmbed], flags: 64 });

    await handleTicketClose(interaction.channel, interaction.user);
  }
});

client.login(config.token);
