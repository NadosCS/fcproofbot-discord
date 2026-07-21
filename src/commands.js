import {
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';

const songOption = (option, description, required = true) =>
  option
    .setName('song')
    .setDescription(description)
    .setRequired(required)
    .setAutocomplete(true);

const playerOption = (option, required = true) =>
  option
    .setName('player')
    .setDescription('The player who achieved the FC')
    .setRequired(required)
    .setAutocomplete(true);

export const commands = [
  new SlashCommandBuilder()
    .setName('addproof')
    .setDescription("Add an FC player and proof to an un-FC'd song")
    .addStringOption((option) =>
      songOption(option, 'Search for an un-FC’d song'),
    )
    .addStringOption((option) => playerOption(option, true))
    .addAttachmentOption((option) =>
      option
        .setName('proof_image')
        .setDescription('Upload a PNG, JPEG, or WebP proof screenshot')
        .setRequired(false),
    )
    .addStringOption((option) =>
      option
        .setName('proof')
        .setDescription('Alternatively, provide an HTTPS image or video link')
        .setRequired(false)
        .setMaxLength(2_000),
    ),

  new SlashCommandBuilder()
    .setName('songinfo')
    .setDescription('Show the current FC player and proof for a song')
    .addStringOption((option) =>
      songOption(option, 'Search all indexed songs'),
    ),

  new SlashCommandBuilder()
    .setName('editproof')
    .setDescription('Replace the player, proof link, or both for a song')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((option) =>
      songOption(option, 'Search all indexed songs'),
    )
    .addStringOption((option) => playerOption(option, false))
    .addStringOption((option) =>
      option
        .setName('proof')
        .setDescription('Replacement HTTPS proof link')
        .setRequired(false)
        .setMaxLength(2_000),
    ),

  new SlashCommandBuilder()
    .setName('removeproof')
    .setDescription('Remove both the FC player and proof from a song')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((option) =>
      songOption(option, 'Search all indexed songs'),
    ),

  new SlashCommandBuilder()
    .setName('botstatus')
    .setDescription('Check the Discord bot and Apps Script backend')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('refreshcatalog')
    .setDescription('Force the bot to reload its autocomplete catalog')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
].map((command) => command.toJSON());
