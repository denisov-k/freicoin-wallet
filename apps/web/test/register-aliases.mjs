// register-aliases.mjs — --import entry that installs alias-loader (see there).
import { register } from 'node:module';
register('./alias-loader.mjs', import.meta.url);
