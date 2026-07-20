/**
 * fix.ms / Pterodactyl launcher.
 *
 * The hosting template always sends MAIN_FILE through ts-node because its
 * JavaScript filename check is broken. This TypeScript launcher imports the
 * actual Discord bot entry file.
 */
import './src/index.js';
