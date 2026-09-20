import "dotenv/config";
import { loadConfig } from "./config.js";
import { deployCommands } from "./commands.js";

try {
  await deployCommands(loadConfig());
  console.log("Slash Commandを登録しました");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
