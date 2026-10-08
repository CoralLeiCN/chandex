import { backup, restore } from "../src/storage/backup.ts";
const [action, source, target] = process.argv.slice(2);
if (!["backup", "restore"].includes(action) || !source || !target)
  throw new Error(
    "Usage: npm run data -- backup|restore SOURCE_DIR NEW_DESTINATION_DIR",
  );
(action === "backup" ? backup : restore)(source, target);
console.log(action + " completed: " + target);
