// Lets plain node run the workspace's TypeScript packages. persona, channels
// and guardian import siblings as "./x.js" (their bundlers map that to x.ts);
// node does not, so a relative .js import that does not exist retries as .ts.
// Every quality script and test starts with: node --import ./src/register.ts
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== "ERR_MODULE_NOT_FOUND" || !/^\.\.?\/.*\.js$/.test(specifier)) throw err;
      return next(specifier.replace(/\.js$/, ".ts"), context);
    }
  },
});
