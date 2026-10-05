import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const profile = process.env.DSH_PROFILE_DIR ?? join(homedir(), '.dsh', 'profiles', 'web');
process.env.DSH_PROFILE_DIR = profile;
export const packages = process.env.DSH_TOOLS_DIR ?? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai');
if (!existsSync(join(packages, 'dsh-session', 'lib', 'index.js'))) throw new Error('Set DSH_TOOLS_DIR to the installed runtime packages directory');
export const load = (relative) => import(pathToFileURL(join(packages, relative)).href);
