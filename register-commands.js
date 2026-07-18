import { REST, Routes } from 'discord.js';
import { commands } from './src/commands.js';
import { config } from './src/config.js';

const rest = new REST({ version: '10' }).setToken(config.discordToken);

console.log(
  `Registering ${commands.length} guild command(s) in ${config.discordGuildId}...`,
);

try {
  const registered = await rest.put(
    Routes.applicationGuildCommands(
      config.discordClientId,
      config.discordGuildId,
    ),
    { body: commands },
  );

  console.log(`Registered ${registered.length} command(s) successfully.`);
  for (const command of registered) {
    console.log(`- /${command.name}`);
  }
} catch (error) {
  console.error('Command registration failed:', error);
  process.exitCode = 1;
}
