import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const sourceDirectory = path.resolve('apps-script');
const filenames = [
  'Config.gs',
  'Helpers.gs',
  'SongIndex.gs',
  'DiscordAPI.gs',
];

for (const filename of filenames) {
  const absolutePath = path.join(sourceDirectory, filename);
  const source = fs.readFileSync(absolutePath, 'utf8');
  new vm.Script(source, { filename: absolutePath });
}

console.log(`Checked ${filenames.length} Apps Script source files.`);
