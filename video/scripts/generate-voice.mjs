import {KokoroTTS} from 'kokoro-js';
import {readdir, readFile, mkdir} from 'node:fs/promises';
import path from 'node:path';

const narrationDir = path.resolve('narration');
const outputDir = path.resolve('public/audio');
await mkdir(outputDir, {recursive: true});
const tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
  dtype: 'q8',
  device: 'cpu',
});
for (const file of (await readdir(narrationDir)).filter((name) => name.endsWith('.txt')).sort()) {
  const text = (await readFile(path.join(narrationDir, file), 'utf8')).trim();
  const audio = await tts.generate(text, {voice: 'af_heart', speed: 1.02});
  const output = path.join(outputDir, file.replace(/\.txt$/, '.wav'));
  audio.save(output);
  console.log(`${file} -> ${output}`);
}
