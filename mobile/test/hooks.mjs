// Chạy code mobile/src/video/* trong Node: thay module của Expo bằng bản giả có cùng hành vi bất đồng bộ với SDK 58.
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

const fake = (n) => new URL(`./fakes/${n}.ts`, import.meta.url).href;
const map = { 'expo-file-system': fake('fs'), 'expo-crypto': fake('crypto'), 'expo-video-thumbnails': fake('thumbs') };

registerHooks({
  resolve(spec, ctx, next) {
    if (map[spec]) return { url: map[spec], shortCircuit: true };
    const fromApp = ctx.parentURL?.includes('/mobile/src/');
    if (spec === '../api' && fromApp) return { url: fake('api'), shortCircuit: true };
    if (/^\.\.?\//.test(spec) && fromApp) {
      const u = new URL(`${spec}.ts`, ctx.parentURL);
      if (existsSync(fileURLToPath(u))) return { url: u.href, shortCircuit: true };
    }
    return next(spec, ctx);
  },
});
