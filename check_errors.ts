import Database from "better-sqlite3";
const db = new Database("database.db");
try {
    const instances: any[] = db.prepare("SELECT id, name, status, lastError FROM instances").all();
    console.log(JSON.stringify(instances, null, 2));
} catch (e: any) {
    console.error(e.message);
}
db.close();
