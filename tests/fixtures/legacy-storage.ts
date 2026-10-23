import type { Store } from "../../src/storage/store.ts";

/** Build the real pre-Trash shape for migration/backup tests. */
export function schema17(store: Store) {
  store.db.exec(`
    DROP TABLE IF EXISTS note_saves;
    DROP TRIGGER note_search_insert;
    DROP TRIGGER note_search_update;
    ALTER TABLE artifacts DROP COLUMN trashed_at;
    ALTER TABLE artifacts DROP COLUMN trash_version;
    DROP TABLE deleted_notes;
    DELETE FROM migrations WHERE version>=18;
    CREATE TRIGGER note_search_insert AFTER INSERT ON artifacts BEGIN
      INSERT INTO note_fts(artifact_id,title,text) SELECT NEW.id,NEW.title,note_text(NEW.content) WHERE NEW.unavailable=0 OR NEW.authored=1;
    END;
    CREATE TRIGGER note_search_update AFTER UPDATE OF title,content,authored,unavailable ON artifacts BEGIN
      DELETE FROM note_fts WHERE artifact_id=OLD.id;
      INSERT INTO note_fts(artifact_id,title,text) SELECT NEW.id,NEW.title,note_text(NEW.content) WHERE NEW.unavailable=0 OR NEW.authored=1;
    END;
  `);
}
