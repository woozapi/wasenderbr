import express from "express";
import { createServer as createViteServer } from "vite";
import * as path from "path";
import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, delay, jidNormalizedUser, downloadMediaMessage } from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
import QRCode from "qrcode";
import Database from "better-sqlite3";
import cors from "cors";
import bodyParser from "body-parser";
import { Server } from "socket.io";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { createServer } from "http";
import { GoogleGenAI } from "@google/genai";
import multer from "multer";

dotenv.config();

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const isSupabase = process.env.DB_TYPE === "supabase";

const supabase = SUPABASE_URL ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY) : null;
const db = new Database("database.db");

// Supabase Storage Bucket
const BUCKET_NAME = "wasenderbr";

async function uploadToSupabase(buffer: Buffer, filename: string, mimeType: string): Promise<string | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.storage
    .from(BUCKET_NAME)
    .upload(filename, buffer, { contentType: mimeType, upsert: true });

  if (error) {
    console.error("[SUPABASE_STORAGE_ERROR]", error.message);
    return null;
  }

  const { data: publicUrl } = supabase.storage.from(BUCKET_NAME).getPublicUrl(filename);
  return publicUrl.publicUrl;
}

// Database Abstraction
interface IDatabase {
  query(sql: string, params?: any[]): Promise<any[]>;
  get(sql: string, params?: any[]): Promise<any>;
  run(sql: string, params?: any[]): Promise<{ lastInsertRowid: number | bigint }>;
  exec(sql: string): Promise<void>;
}

const sqliteDB: IDatabase = {
  query: async (sql, params = []) => db.prepare(sql).all(...params),
  get: async (sql, params = []) => db.prepare(sql).get(...params),
  run: async (sql, params = []) => {
    const info = db.prepare(sql).run(...params);
    return { lastInsertRowid: info.lastInsertRowid };
  },
  exec: async (sql) => { db.exec(sql); }
};

const supabaseDB: IDatabase = {
  query: async (sql, params = []) => {
    // Basic mapping for SELECT queries
    // This is a simplified version; real-world apps should use an ORM or dedicated service
    const tableMatch = sql.match(/FROM\s+(\w+)/i);
    if (!tableMatch) return [];
    const table = tableMatch[1];
    
    const isCount = /SELECT\s+COUNT\(\*\)/i.test(sql);
    let query = isCount ? supabase!.from(table).select("*", { count: 'exact', head: true }) : supabase!.from(table).select("*");
    
    if (sql.includes("WHERE") && params.length > 0) {
      const whereMatch = sql.match(/WHERE\s+(\w+)\s*=/i);
      if (whereMatch) {
        query = query.eq(whereMatch[1], params[0]);
      }
    }
    
    if (isCount) {
        const { count, error } = await query;
        if (error) console.error("Supabase count error:", error);
        return [{ count: count || 0 }];
    }
    
    const { data, error } = await query;
    if (error) console.error("Supabase query error:", error);
    return data || [];
  },
  get: async (sql, params = []) => {
    const data = await supabaseDB.query(sql, params);
    return data && data.length > 0 ? data[0] : null;
  },
  run: async (sql, params = []) => {
    // Mapping for INSERT/UPDATE
    // Mapping for INSERT (including OR IGNORE)
    const insertMatch = sql.match(/(?:INSERT INTO|INSERT OR IGNORE INTO)\s+(\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i);
    if (insertMatch) {
      const table = insertMatch[1];
      const cols = insertMatch[2].split(",").map(c => c.trim());
      const obj: any = {};
      cols.forEach((col, i) => {
        obj[col] = params[i];
      });
      
      let query = supabase!.from(table).insert(obj);
      if (sql.includes("IGNORE")) {
          // Supabase doesn't have a direct "ignore", but we can use upsert with a dummy conflict target if needed
          // For now, a regular insert is fine as Supabase will throw error on PK conflict anyway
      }
      const { data, error } = await query.select();
      if (error) { console.error("Supabase insert error:", JSON.stringify(error)); }
      return { lastInsertRowid: data && data.length > 0 ? data[0].id : 0 };
    }
    
    const updateMatch = sql.match(/UPDATE\s+(\w+)\s+SET\s+(.+?)(?:\s+WHERE\s+(.+))?$/i);
    if (updateMatch) {
        const table = updateMatch[1];
        const setClause = updateMatch[2];
        const whereClause = updateMatch[3];
        
        const obj: any = {};
        const sets = setClause.split(",").map(s => s.trim());
        let paramIdx = 0;
        sets.forEach((set) => {
            const parts = set.split("=");
            const col = parts[0].trim();
            const val = parts[1].trim();
            if (val === "?") {
              obj[col] = params[paramIdx++];
            }
        });
        
        let query = supabase!.from(table).update(obj);
        if (whereClause) {
            const whereParts = whereClause.split(/\s+AND\s+/i);
            whereParts.forEach((part) => {
                const parts = part.split("=");
                const col = parts[0].trim();
                const val = parts[1]?.trim();
                if (val === "?") {
                  query = query.eq(col, params[paramIdx++]);
                }
            });
        }
        const { error } = await query;
        if (error) { console.error("Supabase update error:", JSON.stringify(error)); }
        return { lastInsertRowid: 0 };
    }

    const deleteMatch = sql.match(/DELETE\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+))?/i);
    if (deleteMatch) {
      const table = deleteMatch[1];
      const whereClause = deleteMatch[2];
      let query = supabase!.from(table).delete();
      if (whereClause) {
        const whereParts = whereClause.split(/\s+AND\s+/i);
        whereParts.forEach((part, idx) => {
            const col = part.split("=")[0].trim();
            query = query.eq(col, params[idx]);
        });
      }
      const { error } = await query;
      if (error) { console.error("Supabase delete error:", JSON.stringify(error)); }
      return { lastInsertRowid: 0 };
    }
    
    return { lastInsertRowid: 0 };
  },
  exec: async (sql) => {
    // exec is mostly for schema, which should be done via dashboard
    console.warn("exec() called on Supabase. This should be handled via the SQL migration script in the dashboard.");
  }
};

const currentDB = isSupabase ? supabaseDB : sqliteDB;

// Initialize DB (Only for SQLite)
if (!isSupabase) {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        plan_id INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS plans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        price REAL DEFAULT 0,
        max_agents INTEGER DEFAULT 1,
        max_campaigns INTEGER DEFAULT 1,
        max_leads INTEGER DEFAULT 100,
        features_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        role TEXT DEFAULT 'admin',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS agents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER,
        name TEXT NOT NULL,
        system_instruction TEXT NOT NULL,
        personality TEXT,
        faq_json TEXT,
        handoff_trigger TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS campaigns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER,
        name TEXT NOT NULL,
        agent_id INTEGER,
        initial_method TEXT DEFAULT 'ai',
        transition_rules TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS instances (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER,
        name TEXT NOT NULL,
        status TEXT DEFAULT 'none',
        phone_connected TEXT,
        lastError TEXT,
        engine TEXT DEFAULT 'baileys',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS contacts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        phone TEXT UNIQUE NOT NULL,
        push_name TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_jid TEXT UNIQUE NOT NULL,
        subject TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER,
        instance_id INTEGER,
        type TEXT,
        contact_phone TEXT,
        group_jid TEXT,
        title TEXT,
        last_message_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER,
        instance_id INTEGER,
        conversation_id INTEGER,
        direction TEXT,
        chat_type TEXT,
        author_phone TEXT,
        author_push_name TEXT,
        content_type TEXT,
        content_text TEXT,
        message_id TEXT UNIQUE,
        sender TEXT,
        raw_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
      CREATE INDEX IF NOT EXISTS idx_messages_account ON messages(account_id);
      CREATE INDEX IF NOT EXISTS idx_conversations_account ON conversations(account_id);
      CREATE INDEX IF NOT EXISTS idx_conversations_last_msg ON conversations(last_message_at);
      CREATE INDEX IF NOT EXISTS idx_leads_account ON leads(account_id);
      CREATE INDEX IF NOT EXISTS idx_messages_msgid ON messages(message_id);

      CREATE TABLE IF NOT EXISTS team_members (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER,
        name TEXT NOT NULL,
        role TEXT,
        email TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS llm_credentials (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER,
        provider TEXT NOT NULL,
        name TEXT NOT NULL,
        api_key TEXT NOT NULL,
        model_name TEXT,
        is_active BOOLEAN DEFAULT false,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS leads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER,
        name TEXT,
        phone TEXT,
        address TEXT,
        niche TEXT,
        status TEXT DEFAULT 'pending',
        kanban_status TEXT DEFAULT 'new',
        campaign_id INTEGER,
        last_interaction_type TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS schedules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER,
        name TEXT NOT NULL,
        agent_id INTEGER,
        member_id INTEGER,
        description TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
  } catch (e) {
    console.error("SQLite initialization error:", e);
  }
}

// Migrations for existing databases
if (!isSupabase) {
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[];
    const tableNames = tables.map(t => t.name);

    if (tableNames.includes('messages')) {
      const columns = db.prepare("PRAGMA table_info(messages)").all() as any[];
      const columnNames = columns.map(c => c.name);
      
      const requiredColumns = [
        { name: 'account_id', type: 'INTEGER' },
        { name: 'instance_id', type: 'INTEGER' },
        { name: 'conversation_id', type: 'INTEGER' },
        { name: 'direction', type: 'TEXT' },
        { name: 'chat_type', type: 'TEXT' },
        { name: 'author_phone', type: 'TEXT' },
        { name: 'author_push_name', type: 'TEXT' },
        { name: 'content_type', type: 'TEXT' },
        { name: 'content_text', type: 'TEXT' },
        { name: 'raw_json', type: 'TEXT' },
        { name: 'message_id', type: 'TEXT' },
        { name: 'sender', type: 'TEXT' }
      ];

      for (const col of requiredColumns) {
        if (!columnNames.includes(col.name)) {
          try {
            db.exec(`ALTER TABLE messages ADD COLUMN ${col.name} ${col.type}`);
            if (col.name === 'message_id') {
              db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_msgid ON messages(message_id)`);
            }
          } catch (e) {
            console.error(`Error adding column ${col.name}:`, e);
          }
        }
      }
    }

    if (tableNames.includes('instances')) {
      const columns = db.prepare("PRAGMA table_info(instances)").all() as any[];
      if (!columns.find(c => c.name === 'phoneConnected')) {
        db.exec("ALTER TABLE instances ADD COLUMN phoneConnected TEXT");
      }
      if (!columns.find(c => c.name === 'engine')) {
        db.exec("ALTER TABLE instances ADD COLUMN engine TEXT DEFAULT 'baileys'");
      }
    }
  } catch (e) {
    console.error("Migration error:", e);
  }
}

function normalizePhone(jidOrPhone: string): string {
  if (!jidOrPhone) return '';
  const parts = jidOrPhone.split('@');
  const id = parts[0];
  const suffix = parts[1];

  // If it's a LID, we return it as is but mark it if needed. 
  // However, for messaging, we want the phone.
  if (suffix === 'lid' || suffix === 's.whatsapp.net' || suffix === 'g.us') {
    return jidOrPhone; // Pass through valid JIDs
  }

  let cleaned = id.replace(/\D/g, '');
  if (cleaned.startsWith('0')) cleaned = cleaned.substring(1);
  if (cleaned.length === 10 || cleaned.length === 11) {
    cleaned = '55' + cleaned;
  }
  return cleaned;
}

// ==============================================
// Native Supabase Service (bypasses regex wrapper)
// ==============================================

// Column cache: detect available columns at runtime
const schemaCache: Record<string, Set<string>> = {};

async function detectTableColumns(table: string) {
  if (!supabase || (schemaCache[table] && schemaCache[table].size > 0)) return;
  
  if (!schemaCache[table]) schemaCache[table] = new Set();
  
  // Probe by selecting one row - the returned keys are the available columns
  const { data } = await supabase.from(table).select('*').limit(1);
  if (data && data.length > 0) {
    Object.keys(data[0]).forEach(k => schemaCache[table].add(k));
    console.log(`[SCHEMA_DETECT] ${table} columns:`, [...schemaCache[table]].join(', '));
  } else {
    // Fallbacks for empty tables
    if (table === 'messages') {
      ['id','account_id','instance_id','conversation_id','direction','chat_type',
       'author_phone','author_push_name','content_type','content_text','message_id',
       'raw_json','created_at','delivery_status','provider_message_id','from_me','error_details'
      ].forEach(c => schemaCache[table].add(c));
    } else if (table === 'instances') {
      ['id', 'account_id', 'name', 'status', 'phone_connected', 'updated_at', 'created_at'].forEach(c => schemaCache[table].add(c));
    }
    console.log(`[SCHEMA_DETECT] ${table} table empty, using fallback column set`);
  }
}

function stripUnknownColumns(table: string, data: Record<string, any>): Record<string, any> {
  const cache = schemaCache[table];
  if (!cache || cache.size === 0) return data; 
  const cleaned: Record<string, any> = {};
  for (const [key, value] of Object.entries(data)) {
    if (cache.has(key)) {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

const supa = {
  async upsertContact(phone: string, pushName: string | null) {
    if (!supabase) return;
    const { error } = await supabase.from('contacts').upsert(
      { phone, push_name: pushName, updated_at: new Date().toISOString() },
      { onConflict: 'phone' }
    );
    if (error) console.error('[SUPABASE_ERROR] upsertContact:', error.message);
  },

  async upsertGroup(groupJid: string, subject: string) {
    if (!supabase) return;
    const { error } = await supabase.from('groups').upsert(
      { group_jid: groupJid, subject, updated_at: new Date().toISOString() },
      { onConflict: 'group_jid' }
    );
    if (error) console.error('[SUPABASE_ERROR] upsertGroup:', error.message);
  },

  async findConversation(instanceId: number, contactPhone: string | null, groupJid: string | null) {
    if (!supabase) return null;
    let query = supabase.from('conversations').select('*').eq('instance_id', instanceId);
    if (groupJid) {
      query = query.eq('group_jid', groupJid);
    } else if (contactPhone) {
      query = query.eq('contact_phone', contactPhone);
    } else {
      return null;
    }
    const { data, error } = await query.maybeSingle();
    if (error) console.error('[SUPABASE_ERROR] findConversation:', error.message);
    return data;
  },

  async createConversation(accountId: number, instanceId: number, type: string, contactPhone: string | null, groupJid: string | null, title: string) {
    if (!supabase) return { id: 0 };
    const { data, error } = await supabase.from('conversations').insert({
      account_id: accountId,
      instance_id: instanceId,
      type,
      contact_phone: contactPhone,
      group_jid: groupJid,
      title,
      last_message_at: new Date().toISOString()
    }).select().single();
    if (error) { console.error('[SUPABASE_ERROR] createConversation:', error.message); return { id: 0 }; }
    return data;
  },

  async updateConversation(id: number, updates: Record<string, any>) {
    if (!supabase) return;
    const payload = { ...updates, updated_at: new Date().toISOString() };
    const { error } = await supabase.from('conversations').update(payload).eq('id', id);
    if (error) {
      // If a column doesn't exist, retry without the unknown fields
      if (error.message?.includes('column') || error.code === 'PGRST204') {
        console.warn('[SUPABASE_WARN] updateConversation unknown column, retrying with safe fields only');
        const safePayload: any = { updated_at: new Date().toISOString() };
        if (updates.last_message_at) safePayload.last_message_at = updates.last_message_at;
        if (updates.title) safePayload.title = updates.title;
        const { error: err2 } = await supabase.from('conversations').update(safePayload).eq('id', id);
        if (err2) console.error('[SUPABASE_ERROR] updateConversation retry:', err2.message);
      } else {
        console.error('[SUPABASE_ERROR] updateConversation:', error.message);
      }
    }
  },

  async upsertMessage(data: Record<string, any>): Promise<any> {
    if (!supabase) return null;
    await detectTableColumns('messages');
    const cleanData = stripUnknownColumns('messages', data);
    const { data: result, error } = await supabase.from('messages').upsert(
      cleanData,
      { onConflict: 'message_id' }
    ).select().single();
    if (error) {
      console.error('[SUPABASE_INSERT_ERROR]', JSON.stringify(error));
      return null;
    }
    console.log('[SUPABASE_INSERT_SUCCESS] message_id:', data.message_id);
    return result;
  },

  async updateMessageStatus(messageId: string, status: string, extras?: Record<string, any>) {
    if (!supabase) return;
    await detectTableColumns('messages');
    const updates = stripUnknownColumns('messages', {
      delivery_status: status,
      ...extras
    });
    if (Object.keys(updates).length === 0) {
      console.log(`[SUPABASE_STATUS_UPDATE] skipped (no known columns for status update)`);
      return;
    }
    const { error } = await supabase.from('messages').update(updates).eq('message_id', messageId);
    if (error) console.error('[SUPABASE_STATUS_UPDATE_ERROR]', error.message);
    else console.log(`[SUPABASE_STATUS_UPDATE] ${messageId} -> ${status}`);
  },

  async getConversations(accountId: number) {
    if (!supabase) return [];
    const { data, error } = await supabase.from('conversations')
      .select('*')
      .eq('account_id', accountId)
      .order('last_message_at', { ascending: false });
    if (error) { console.error('[SUPABASE_ERROR] getConversations:', error.message); return []; }
    return data || [];
  },

  async getMessages(conversationId: number, accountId: number) {
    if (!supabase) return [];
    const { data, error } = await supabase.from('messages')
      .select('*')
      .eq('conversation_id', conversationId)
      .eq('account_id', accountId)
      .order('created_at', { ascending: true });
    if (error) { console.error('[SUPABASE_ERROR] getMessages:', error.message); return []; }
    return data || [];
  },

  async getInstances(accountId: number) {
    if (!supabase) return [];
    const { data, error } = await supabase.from('instances')
      .select('*')
      .eq('account_id', accountId);
    if (error) { console.error('[SUPABASE_ERROR] getInstances:', error.message); return []; }
    return data || [];
  },

  async updateInstanceStatus(instanceId: number, status: string, phoneConnected?: string | null) {
    if (!supabase) return;
    await detectTableColumns('instances');
    const updates: any = { status, updated_at: new Date().toISOString() };
    if (phoneConnected !== undefined) updates.phone_connected = phoneConnected;
    const cleaned = stripUnknownColumns('instances', updates);
    const { error } = await supabase.from('instances').update(cleaned).eq('id', instanceId);
    if (error) console.error('[SUPABASE_ERROR] updateInstanceStatus:', error.message);
  }
};

interface IWhatsAppDriver {
  connect(): Promise<void>;
  sendMessage(jid: string, text: string, conversationId: number, accountId: number, options?: any): Promise<any>;
  logout(): Promise<void>;
}

class BaileysDriver implements IWhatsAppDriver {
  private sock: any;
  private instanceId: number;
  private accountId: number;
  private io: Server;
  private manager: InstanceManager;

  constructor(instanceId: number, accountId: number, io: Server, manager: InstanceManager) {
    this.instanceId = instanceId;
    this.accountId = accountId;
    this.io = io;
    this.manager = manager;
  }

  async connect() {
    const { state, saveCreds } = await useMultiFileAuthState(`auth_info_baileys_${this.instanceId}`);
    const { version } = await fetchLatestBaileysVersion();

    this.sock = makeWASocket({
      version,
      printQRInTerminal: false,
      auth: state,
      logger: pino({ level: "silent" }),
    });

    this.sock.ev.on("connection.update", async (update: any) => {
      const { connection, lastDisconnect, qr } = update;
      let status: string = connection || 'none';
      let phoneConnected = null;

      if (qr) {
        status = 'qr';
        const qrBase64 = await QRCode.toDataURL(qr);
        this.io.to(`account:${this.accountId}`).emit("instance.qr", { instanceId: this.instanceId, qr: qrBase64 });
      }

      if (connection === "open") {
        console.log(`[BaileysDriver] Instance ${this.instanceId} connected.`);
        phoneConnected = normalizePhone(this.sock.user?.id || '');
        if (isSupabase) {
          await supa.updateInstanceStatus(this.instanceId, status, phoneConnected);
        } else {
          await currentDB.run("UPDATE instances SET status = ?, phone_connected = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [status, phoneConnected, this.instanceId]);
        }
      } else if (connection === "close") {
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        if (shouldReconnect) {
          status = 'reconnecting';
          setTimeout(() => this.connect(), 5000);
        } else {
          status = 'close';
        }
        if (isSupabase) await supa.updateInstanceStatus(this.instanceId, status);
        else await currentDB.run("UPDATE instances SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [status, this.instanceId]);
      }
      this.io.to(`account:${this.accountId}`).emit("instance.status", { instanceId: this.instanceId, status, phoneConnected });
    });

    this.sock.ev.on("creds.update", saveCreds);

    // Re-use existing message logic here... (omitted for brevity in this replace, ideally we move the handler)
    this.manager.setupBaileysHandlers(this.instanceId, this.sock, this.accountId);
  }

  async sendMessage(jid: string, text: string, conversationId: number, accountId: number, options?: { mediaUrl?: string, contentType?: string }) {
    const finalJid = jid.includes('@') ? jid : `${jid}@s.whatsapp.net`;
    const localMessageId = `out_${Date.now()}`;
    const contentType = options?.contentType || 'text';
    const contentText = options?.mediaUrl || text;
    
    if (isSupabase) {
      await supa.upsertMessage({
        account_id: accountId, instance_id: this.instanceId, conversation_id: conversationId,
        direction: 'outbound', chat_type: finalJid.endsWith('@g.us') ? 'group' : 'contact',
        author_phone: normalizePhone(this.sock.user?.id || ''), author_push_name: 'Eu',
        content_type: contentType, content_text: contentText, raw_json: {}, message_id: localMessageId,
        delivery_status: 'pending', from_me: true
      });
    }

    try {
      let result;
      if (options?.mediaUrl) {
         const mediaUrl = options.mediaUrl;
         if (contentType === 'image') {
           result = await this.sock.sendMessage(finalJid, { image: { url: mediaUrl }, caption: text });
         } else if (contentType === 'audio') {
           result = await this.sock.sendMessage(finalJid, { audio: { url: mediaUrl }, mimetype: 'audio/mp4', ptt: true });
         } else if (contentType === 'video') {
           result = await this.sock.sendMessage(finalJid, { video: { url: mediaUrl }, caption: text });
         } else {
           result = await this.sock.sendMessage(finalJid, { document: { url: mediaUrl }, mimetype: 'application/octet-stream', fileName: 'documento' });
         }
      } else {
        result = await this.sock.sendMessage(finalJid, { text });
      }

      if (isSupabase) {
        await supa.updateMessageStatus(localMessageId, 'sent', { provider_message_id: result.key.id, raw_json: result });
      }
      this.io.to(`account:${accountId}`).emit("message.status", { messageId: localMessageId, status: 'sent', providerMessageId: result.key.id });
      return { success: true, localMessageId, providerMessageId: result.key.id };
    } catch (e: any) {
      if (isSupabase) await supa.updateMessageStatus(localMessageId, 'failed', { error_details: e.message });
      this.io.to(`account:${accountId}`).emit("message.status", { messageId: localMessageId, status: 'failed', error: e.message });
      throw e;
    }
  }

  async logout() {
    if (this.sock) await this.sock.logout();
  }
}

class WhatsmeowDriver implements IWhatsAppDriver {
  private instanceId: number;
  private accountId: number;
  private io: Server;
  private bridgeUrl = "http://localhost:3001";

  constructor(instanceId: number, accountId: number, io: Server) {
    this.instanceId = instanceId;
    this.accountId = accountId;
    this.io = io;
  }

  async connect() {
    console.log(`[WhatsmeowDriver] Connecting instance ${this.instanceId} via Go Bridge...`);
    try {
      const resp = await fetch(`${this.bridgeUrl}/instances/${this.instanceId}/connect`, { 
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_id: this.accountId })
      });
      const data = await resp.json() as any;
      console.log(`[WhatsmeowDriver] Bridge response:`, data);
      this.io.to(`account:${this.accountId}`).emit("instance.status", { instanceId: this.instanceId, status: 'connecting' });
    } catch (e: any) {
      console.error(`[WhatsmeowDriver] Failed to connect to bridge:`, e.message);
    }
  }

  async sendMessage(jid: string, text: string, conversationId: number, accountId: number, options?: any) {
    console.log(`[WhatsmeowDriver] Sending message to ${jid} via bridge...`);
    try {
      const resp = await fetch(`${this.bridgeUrl}/instances/${this.instanceId}/send`, {
        method: 'POST',
        body: JSON.stringify({ jid, text }),
        headers: { 'Content-Type': 'application/json' }
      });
      const data = await resp.json() as any;
      
      const localMessageId = `out_wm_${Date.now()}`;
      this.io.to(`account:${this.accountId}`).emit("message.status", {
        messageId: localMessageId,
        status: 'sent',
        providerMessageId: data.MessageID
      });

      return { success: true, localMessageId, providerMessageId: data.MessageID };
    } catch (e: any) {
      console.error(`[WhatsmeowDriver] Send error:`, e.message);
      throw e;
    }
  }

  async logout() {
     // bridge logout call
  }
}

class InstanceManager {
  private instances: Map<number, IWhatsAppDriver> = new Map();
  private io: Server;

  constructor(io: Server) {
    this.io = io;
  }

  async initAll() {
    const instances = await currentDB.query("SELECT * FROM instances");
    for (const inst of instances) {
      if (inst.status === 'open' || inst.status === 'connecting' || inst.status === 'reconnecting') {
        this.connect(inst.id, inst.account_id, inst.engine || 'baileys');
      }
    }
  }

  async connect(instanceId: number, accountId: number, engine: string = 'baileys') {
    if (this.instances.get(instanceId)) return;

    let driver: IWhatsAppDriver;
    if (engine === 'whatsmeow') {
      driver = new WhatsmeowDriver(instanceId, accountId, this.io);
    } else {
      driver = new BaileysDriver(instanceId, accountId, this.io, this);
    }

    this.instances.set(instanceId, driver);
    await driver.connect();
  }

  async logout(instanceId: number) {
    const driver = this.instances.get(instanceId);
    if (driver) {
      await driver.logout();
      this.instances.delete(instanceId);
    }
  }

  async sendMessage(instanceId: number, accountId: number, conversationId: number, jid: string, text: string, options?: any) {
    const driver = this.instances.get(instanceId);
    if (!driver) throw new Error("Instância não conectada.");
    return await driver.sendMessage(jid, text, conversationId, accountId, options);
  }

  setupBaileysHandlers(instanceId: number, sock: any, accountId: number) {
    sock.ev.on("messages.upsert", async (m: any) => {
      if (m.type !== 'notify') return;

      for (const msg of m.messages) {
        try {
          if (!msg.message || msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJid?.endsWith('@newsletter')) continue;

          const remoteJid = msg.key.remoteJid;
          const isGroup = remoteJid.endsWith('@g.us');
          const chatType = isGroup ? 'group' : 'contact';
          const direction = msg.key.fromMe ? 'outbound' : 'inbound';
          const participant = msg.key.participant || remoteJid;
          const authorPhone = normalizePhone(participant);
          
          let contactPhone: string | null = null;
          if (!isGroup) {
            if (remoteJid.endsWith('@s.whatsapp.net')) {
              contactPhone = normalizePhone(remoteJid);
            } else if (remoteJid.endsWith('@lid')) {
              contactPhone = remoteJid;
            }
          }
          const groupJid = isGroup ? remoteJid : null;
          const pushName = msg.pushName || null;

          let contentText = msg.message?.conversation || msg.message?.extendedTextMessage?.text || null;
          const mediaMsg = msg.message?.imageMessage || msg.message?.videoMessage || msg.message?.audioMessage || msg.message?.documentMessage;
          const contentType = msg.message?.imageMessage ? 'image' :
                             msg.message?.videoMessage ? 'video' :
                             msg.message?.audioMessage ? 'audio' :
                             msg.message?.documentMessage ? 'document' : 'text';

          let mediaUrl: string | null = null;
          if (mediaMsg) {
            try {
              console.log(`[BAILEYS_MEDIA] Downloading ${contentType}...`);
              const buffer = await downloadMediaMessage(msg, 'buffer', {});
              const extension = contentType === 'image' ? 'jpg' : 
                                contentType === 'audio' ? 'ogg' : 
                                contentType === 'video' ? 'mp4' : 
                                mediaMsg.mimetype?.split('/')[1] || 'bin';
              const filename = `${instanceId}_${msg.key.id}.${extension}`;
              mediaUrl = await uploadToSupabase(buffer as Buffer, filename, mediaMsg.mimetype || 'application/octet-stream');
              if (mediaUrl) {
                contentText = mediaUrl; // Store URL in contentText for simplicity or UI to pick up
                console.log(`[BAILEYS_MEDIA] Uploaded: ${mediaUrl}`);
              }
            } catch (e: any) {
              console.error(`[BAILEYS_MEDIA_ERROR]`, e.message);
            }
          }

          if (isSupabase) {
            if (!msg.key.fromMe && authorPhone) await supa.upsertContact(authorPhone, pushName);
            let conv = await supa.findConversation(instanceId, contactPhone, groupJid);
            if (!conv) {
              let title = pushName || authorPhone;
              if (isGroup) { try { const meta = await sock.groupMetadata(remoteJid); title = meta.subject; await supa.upsertGroup(remoteJid, title); } catch (e) { title = 'Grupo'; } }
              conv = await supa.createConversation(accountId, instanceId, chatType, contactPhone, groupJid, title);
            }
            const saved = await supa.upsertMessage({
              account_id: accountId, instance_id: instanceId, conversation_id: conv.id,
              direction, chat_type: chatType, author_phone: authorPhone, author_push_name: pushName,
              content_type: contentType, content_text: contentText, raw_json: msg,
              message_id: msg.key.id, delivery_status: direction === 'inbound' ? 'received' : 'sent',
              from_me: msg.key.fromMe || false
            });
            await supa.updateConversation(conv.id, {
              last_message_at: new Date().toISOString(),
              last_message_preview: (contentText || `[${contentType}]`).substring(0, 100)
            });
            this.io.to(`account:${accountId}`).emit("message.new", { instanceId, conversationId: conv.id, message: saved });
          } else {
            if (!msg.key.fromMe && authorPhone) await currentDB.run(`INSERT OR IGNORE INTO contacts (phone, push_name) VALUES (?, ?)`, [authorPhone, pushName]);
            let conv = await currentDB.get("SELECT * FROM conversations WHERE instance_id = ? AND (contact_phone = ? OR group_jid = ?)", [instanceId, contactPhone, groupJid]);
            if (!conv) {
              let title = pushName || authorPhone;
              if (isGroup) { try { const meta = await sock.groupMetadata(remoteJid); title = meta.subject; } catch (e) { title = 'Grupo'; } }
              const info = await currentDB.run(`INSERT INTO conversations (account_id, instance_id, type, contact_phone, group_jid, title) VALUES (?, ?, ?, ?, ?, ?)`, [accountId, instanceId, chatType, contactPhone, groupJid, title]);
              conv = { id: info.lastInsertRowid, title };
            }
            await currentDB.run(`INSERT OR IGNORE INTO messages (account_id, instance_id, conversation_id, direction, chat_type, author_phone, author_push_name, content_type, content_text, raw_json, message_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [accountId, instanceId, conv.id, direction, chatType, authorPhone, pushName, contentType, contentText, JSON.stringify(msg), msg.key.id]);
            await currentDB.run("UPDATE conversations SET last_message_at = CURRENT_TIMESTAMP WHERE id = ?", [conv.id]);
            this.io.to(`account:${accountId}`).emit("message.new", { instanceId, conversationId: conv.id, message: { message_id: msg.key.id, direction, content_text: contentText, content_type: contentType, author_push_name: pushName, created_at: new Date().toISOString() }, conversation: { id: conv.id, title: conv.title } });
          }
        } catch (e: any) {
          console.error(`[BAILEYS_ERROR] Error processing message:`, e.message);
        }
      }
    });
  }

  getSocket(instanceId: number) {
    const driver = this.instances.get(instanceId);
    if (driver instanceof BaileysDriver) {
      return (driver as any).sock;
    }
    return null;
  }

  async handleWhatsmeowMessage(instanceId: number, accountId: number, msg: any) {
    try {
      const remoteJid = msg.Info.Chat.String;
      const isGroup = remoteJid.endsWith('@g.us');
      const chatType = isGroup ? 'group' : 'contact';
      const direction = msg.Info.IsFromMe ? 'outbound' : 'inbound';
      const authorPhone = normalizePhone(msg.Info.Sender.String);
      const pushName = msg.Info.PushName || null;
      
      let contactPhone: string | null = null;
      if (!isGroup) contactPhone = normalizePhone(remoteJid);
      const groupJid = isGroup ? remoteJid : null;

      let contentText = msg.Message?.Conversation || msg.Message?.ExtendedTextMessage?.Text || "";
      let contentType = 'text';

      // Media Handling (if bridge sends data or URL)
      if (msg.MediaUrl) {
        contentText = msg.MediaUrl;
        contentType = msg.MediaType || 'document';
      } else if (msg.Message?.ImageMessage) contentType = 'image';
      else if (msg.Message?.AudioMessage) contentType = 'audio';
      else if (msg.Message?.VideoMessage) contentType = 'video';
      else if (msg.Message?.DocumentMessage) contentType = 'document';

      if (isSupabase) {
        if (!msg.Info.IsFromMe && authorPhone) await supa.upsertContact(authorPhone, pushName);
        let conv = await supa.findConversation(instanceId, contactPhone, groupJid);
        if (!conv) {
          const title = isGroup ? 'Grupo' : (pushName || authorPhone);
          conv = await supa.createConversation(accountId, instanceId, chatType, contactPhone, groupJid, title);
        }
        const saved = await supa.upsertMessage({
          account_id: accountId, instance_id: instanceId, conversation_id: conv.id,
          direction, chat_type: chatType, author_phone: authorPhone, author_push_name: pushName,
          content_type: contentType, content_text: contentText, raw_json: msg,
          message_id: msg.Info.ID, delivery_status: direction === 'inbound' ? 'received' : 'sent',
          from_me: msg.Info.IsFromMe || false
        });
        await supa.updateConversation(conv.id, {
          last_message_at: new Date().toISOString(),
          last_message_preview: (contentText || `[${contentType}]`).substring(0, 100)
        });
        this.io.to(`account:${accountId}`).emit("message.new", { instanceId, conversationId: conv.id, message: saved });
      }
    } catch (e: any) {
      console.error(`[WHATSMEOW_HANDLER_ERROR]`, e.message);
    }
  }
}

async function startServer() {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: { origin: "*" }
  });
  const PORT = process.env.PORT || 3000;

  app.use(cors());
  app.use(bodyParser.json());

  const upload = multer({ storage: multer.memoryStorage() });

  app.post("/api/upload", upload.single("file"), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const extension = req.file.originalname.split(".").pop();
    const filename = `upload_${Date.now()}.${extension}`;
    const url = await uploadToSupabase(req.file.buffer, filename, req.file.mimetype);
    if (url) {
      res.json({ url });
    } else {
      res.status(500).json({ error: "Failed to upload to Supabase" });
    }
  });

  const manager = new InstanceManager(io);
  await manager.initAll();

  // Request logger
  app.use((req, res, next) => {
    console.log(`[HTTP] ${req.method} ${req.url}`);
    next();
  });

  io.on("connection", (socket) => {
    const accountId = socket.handshake.query.accountId;
    if (accountId) {
      socket.join(`account:${accountId}`);
    }

    // Whatsmeow Bridge Events via WebSocket
    socket.on("bridge.event", async (data: any) => {
      const { instanceId, accountId: bridgeAccId, event, payload } = data;
      console.log(`[BRIDGE_EVENT] ${event} from instance ${instanceId}`);

      if (event === 'message') {
        // Process Whatsmeow message similar to Baileys
        await manager.handleWhatsmeowMessage(instanceId, bridgeAccId, payload);
      } else if (event === 'status') {
        const { status, phoneConnected } = payload;
        if (isSupabase) await supa.updateInstanceStatus(instanceId, status, phoneConnected);
        io.to(`account:${bridgeAccId}`).emit("instance.status", { instanceId, status, phoneConnected });
      }
    });
  });

  // Middleware to extract account_id
  app.use((req, res, next) => {
    const accountId = req.headers['x-account-id'];
    if (accountId) {
      (req as any).accountId = Number(accountId);
    }
    next();
  });

  // Auth API
  app.post("/api/auth/register", async (req, res) => {
    const { companyName, name, email, password } = req.body;
    try {
      const userCount = await currentDB.get("SELECT COUNT(*) as count FROM users");
      const role = userCount.count === 0 ? 'super_admin' : 'admin';
      
      const accountInfo = await currentDB.run("INSERT INTO accounts (name) VALUES (?)", [companyName]);
      const accountId = accountInfo.lastInsertRowid;
      const userInfo = await currentDB.run("INSERT INTO users (account_id, name, email, password, role) VALUES (?, ?, ?, ?, ?)", [accountId, name, email, password, role]);
      res.json({ success: true, accountId, userId: userInfo.lastInsertRowid });
    } catch (e) {
      res.status(400).json({ error: "Email already exists" });
    }
  });

  app.post("/api/auth/login", async (req, res) => {
    const { email, password } = req.body;
    const user = await currentDB.get("SELECT * FROM users WHERE email = ? AND password = ?", [email, password]);
    if (user) {
      res.json({ success: true, accountId: user.account_id, user });
    } else {
      res.status(401).json({ error: "Invalid credentials" });
    }
  });

  // WhatsApp Instances API
  app.get("/api/whatsapp/instances", async (req, res) => {
    const accountId = (req as any).accountId;
    if (isSupabase) {
      const instances = await supa.getInstances(accountId);
      res.json(instances);
    } else {
      const instances = await currentDB.query("SELECT * FROM instances WHERE account_id = ?", [accountId]);
      res.json(instances);
    }
  });

  app.post("/api/whatsapp/instances", async (req, res) => {
    const accountId = (req as any).accountId;
    const { name, engine } = req.body;
    if (isSupabase) {
      await detectTableColumns('instances');
      const data = stripUnknownColumns('instances', { account_id: accountId, name, engine: engine || 'baileys' });
      const { data: result, error } = await supabase!.from('instances').insert(data).select().single();
      if (error) {
        console.error('[SUPABASE_INSERT_ERROR] instances:', JSON.stringify(error));
        return res.status(500).json({ error: error.message });
      }
      res.json({ id: result.id });
    } else {
      const info = await currentDB.run("INSERT INTO instances (account_id, name, engine) VALUES (?, ?, ?)", [accountId, name, engine || 'baileys']);
      res.json({ id: info.lastInsertRowid });
    }
  });

  app.post("/api/whatsapp/instances/:id/connect", async (req, res) => {
    const accountId = (req as any).accountId;
    const instanceId = Number(req.params.id);
    await manager.connect(instanceId, accountId);
    res.json({ success: true });
  });

  app.post("/api/whatsapp/instances/:id/logout", async (req, res) => {
    const instanceId = Number(req.params.id);
    await manager.logout(instanceId);
    if (isSupabase) {
      await supa.updateInstanceStatus(instanceId, 'none', null);
    } else {
      await currentDB.run("UPDATE instances SET status = 'none', phone_connected = NULL WHERE id = ?", [instanceId]);
    }
    res.json({ success: true });
  });

  app.delete("/api/whatsapp/instances/:id", async (req, res) => {
    const instanceId = Number(req.params.id);
    await manager.logout(instanceId);
    await currentDB.run("DELETE FROM instances WHERE id = ?", [instanceId]);
    res.json({ success: true });
  });

  // Messaging API
  app.get("/api/conversations", async (req, res) => {
    const accountId = (req as any).accountId;
    let convs: any[];
    if (isSupabase) {
      convs = await supa.getConversations(accountId);
    } else {
      convs = await currentDB.query("SELECT * FROM conversations WHERE account_id = ? ORDER BY last_message_at DESC", [accountId]);
    }
    // Simplified filtering
    convs = convs.filter(c => {
      const isNewsletter = (c.group_jid?.endsWith('@newsletter')) || (c.contact_phone?.endsWith('@newsletter'));
      return !isNewsletter;
    });
    res.json(convs);
  });

  app.get("/api/conversations/:id/messages", async (req, res) => {
    const accountId = (req as any).accountId;
    if (isSupabase) {
      const messages = await supa.getMessages(Number(req.params.id), accountId);
      res.json(messages);
    } else {
      const messages = await currentDB.query("SELECT * FROM messages WHERE conversation_id = ? AND account_id = ? ORDER BY created_at ASC", [req.params.id, accountId]);
      res.json(messages);
    }
  });

  app.delete("/api/conversations/:id", async (req, res) => {
    const accountId = (req as any).accountId;
    const convId = Number(req.params.id);
    console.log(`[API] Deleting conversation ${convId} for account ${accountId}`);
    try {
      // Delete messages first (if not cascading)
      await currentDB.run("DELETE FROM messages WHERE conversation_id = ?", [convId]);
      await currentDB.run("DELETE FROM conversations WHERE id = ? AND account_id = ?", [convId, accountId]);
      res.json({ success: true });
    } catch (e: any) {
      console.error(`[API] Error deleting conversation: ${e.message}`);
      res.status(500).json({ error: e.message });
    }
  });

  app.delete("/api/messages/:id", async (req, res) => {
    const accountId = (req as any).accountId;
    await currentDB.run("DELETE FROM messages WHERE id = ? AND account_id = ?", [req.params.id, accountId]);
    res.json({ success: true });
  });


  app.get("/api/messages", async (req, res) => {
    const accountId = (req as any).accountId;
    const messages = await currentDB.query("SELECT * FROM messages WHERE account_id = ? ORDER BY created_at DESC LIMIT 100", [accountId]);
    res.json(messages);
  });

  app.post("/api/messages/save", async (req, res) => {
    const accountId = (req as any).accountId;
    const { lead_id, sender, content } = req.body;
    try {
      // Find lead
      const lead = await currentDB.get("SELECT * FROM leads WHERE id = ? AND account_id = ?", [lead_id, accountId]);
      if (!lead) return res.status(404).json({ error: "Lead not found" });

      const cleanPhone = lead.phone.replace(/\D/g, '');
      const contactPhone = normalizePhone(cleanPhone);

      // Find or create conversation
      let conv = await currentDB.get("SELECT * FROM conversations WHERE account_id = ? AND contact_phone = ?", [accountId, contactPhone]);
      if (!conv) {
        const info = await currentDB.run("INSERT INTO conversations (account_id, type, contact_phone, title) VALUES (?, 'contact', ?, ?)", [accountId, contactPhone, lead.name]);
        conv = { id: info.lastInsertRowid };
      }

      // Save Message
      await currentDB.run(`
        INSERT INTO messages (account_id, conversation_id, direction, content_type, content_text, sender)
        VALUES (?, ?, 'outbound', 'text', ?, ?)
      `, [accountId, conv.id, content, sender]);

      await currentDB.run("UPDATE conversations SET last_message_at = CURRENT_TIMESTAMP WHERE id = ?", [conv.id]);

      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message || "Failed to save message" });
    }
  });

  app.post("/api/whatsapp/send", async (req, res) => {
    const accountId = (req as any).accountId;
    const { instanceId, jid, message, conversationId, mediaUrl, contentType } = req.body;
    console.log(`[FRONT_SEND_REQUEST] jid=${jid} instance=${instanceId} conv=${conversationId} account=${accountId} media=${mediaUrl}`);
    try {
      if (!instanceId) throw new Error("Instância não selecionada.");
      const result = await manager.sendMessage(instanceId, accountId, conversationId || 0, jid, message, { mediaUrl, contentType });
      res.json(result);
    } catch (e: any) {
      console.error(`[API_SEND_ERROR] ${e.message}`);
      res.status(500).json({ error: e.message || "Failed to send message" });
    }
  });

  // Agents API
  app.get("/api/agents", async (req, res) => {
    const accountId = (req as any).accountId;
    const agents = await currentDB.query("SELECT * FROM agents WHERE account_id = ?", [accountId]);
    res.json(agents);
  });

  app.post("/api/agents", async (req, res) => {
    const accountId = (req as any).accountId;
    const { name, system_instruction, personality, faq_json, handoff_trigger } = req.body;
    const info = await currentDB.run("INSERT INTO agents (account_id, name, system_instruction, personality, faq_json, handoff_trigger) VALUES (?, ?, ?, ?, ?, ?)", [
      accountId,
      name, 
      system_instruction,
      personality || null,
      faq_json ? JSON.stringify(faq_json) : null,
      handoff_trigger || null
    ]);
    res.json({ id: info.lastInsertRowid });
  });

  // Campaigns API
  app.get("/api/campaigns", async (req, res) => {
    const accountId = (req as any).accountId;
    const campaigns = await currentDB.query("SELECT * FROM campaigns WHERE account_id = ?", [accountId]);
    res.json(campaigns);
  });

  app.post("/api/campaigns", async (req, res) => {
    const accountId = (req as any).accountId;
    const { name, agent_id, initial_method, transition_rules } = req.body;
    const info = await currentDB.run("INSERT INTO campaigns (account_id, name, agent_id, initial_method, transition_rules) VALUES (?, ?, ?, ?, ?)", [
      accountId,
      name,
      agent_id,
      initial_method,
      JSON.stringify(transition_rules)
    ]);
    res.json({ id: info.lastInsertRowid });
  });

  // Team API
  app.get("/api/team", async (req, res) => {
    const accountId = (req as any).accountId;
    const team = await currentDB.query("SELECT * FROM team_members WHERE account_id = ?", [accountId]);
    res.json(team);
  });

  app.post("/api/team", async (req, res) => {
    const accountId = (req as any).accountId;
    const { name, role, email } = req.body;
    const info = await currentDB.run("INSERT INTO team_members (account_id, name, role, email) VALUES (?, ?, ?, ?)", [accountId, name, role, email]);
    res.json({ id: info.lastInsertRowid });
  });

  // LLM Credentials API
  app.get("/api/credentials", async (req, res) => {
    const accountId = (req as any).accountId;
    const credentials = await currentDB.query("SELECT * FROM llm_credentials WHERE account_id = ?", [accountId]);
    res.json(credentials);
  });

  app.post("/api/ai/generate", async (req, res) => {
    const accountId = (req as any).accountId;
    const { contents, prompt, model, config } = req.body;
    try {
      const [cred] = await currentDB.query("SELECT * FROM llm_credentials WHERE account_id = ? AND provider = 'gemini' AND is_active = 1", [accountId]);
      const apiKey = cred?.api_key || process.env.GEMINI_API_KEY;
      
      if (!apiKey) {
        return res.status(400).json({ error: "Gemini API Key missing (.env or DB)" });
      }

      const genAI = new GoogleGenAI({ apiKey });
      const aiResponse = await genAI.models.generateContent({
        model: model || "gemini-2.0-flash",
        contents: contents || prompt,
        ...config
      });
      
      res.json({ text: aiResponse.text });
    } catch (e: any) {
      console.error("AI Error:", e);
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/credentials", async (req, res) => {
    const accountId = (req as any).accountId;
    const { provider, name, api_key, model_name } = req.body;
    const info = await currentDB.run("INSERT INTO llm_credentials (account_id, provider, name, api_key, model_name) VALUES (?, ?, ?, ?, ?)", [accountId, provider, name, api_key, model_name]);
    res.json({ id: info.lastInsertRowid });
  });

  // Kanban API
  app.patch("/api/leads/:id/kanban", async (req, res) => {
    const accountId = (req as any).accountId;
    const { kanban_status } = req.body;
    await currentDB.run("UPDATE leads SET kanban_status = ? WHERE id = ? AND account_id = ?", [kanban_status, req.params.id, accountId]);
    res.json({ success: true });
  });

  // Schedules API
  app.get("/api/schedules", async (req, res) => {
    const accountId = (req as any).accountId;
    const schedules = await currentDB.query(`
      SELECT s.*, a.name as agent_name, t.name as member_name 
      FROM schedules s
      LEFT JOIN agents a ON s.agent_id = a.id
      LEFT JOIN team_members t ON s.member_id = t.id
      WHERE s.account_id = ?
      ORDER BY s.created_at DESC
    `, [accountId]);
    res.json(schedules);
  });

  app.post("/api/schedules", async (req, res) => {
    const accountId = (req as any).accountId;
    const { name, agent_id, member_id, description } = req.body;
    const info = await currentDB.run("INSERT INTO schedules (account_id, name, agent_id, member_id, description) VALUES (?, ?, ?, ?, ?)", [
      accountId,
      name,
      agent_id || null,
      member_id || null,
      description || null
    ]);
    res.json({ id: info.lastInsertRowid });
  });

  app.delete("/api/schedules/:id", async (req, res) => {
    const accountId = (req as any).accountId;
    await currentDB.run("DELETE FROM schedules WHERE id = ? AND account_id = ?", [req.params.id, accountId]);
    res.json({ success: true });
  });

  // Leads API
  app.get("/api/leads", async (req, res) => {
    const accountId = (req as any).accountId;
    const leads = await currentDB.query("SELECT * FROM leads WHERE account_id = ? ORDER BY created_at DESC", [accountId]);
    res.json(leads);
  });

  app.post("/api/leads", async (req, res) => {
    const accountId = (req as any).accountId;
    const { leads } = req.body;
    
    // For Supabase, we don't have direct transaction support like this, 
    // but we can do a loop or a direct Supabase .insert(arrayOfObjects)
    // For simplicity with our currentDB abstraction:
    for (const lead of leads) {
        await currentDB.run("INSERT INTO leads (account_id, name, phone, address, niche) VALUES (?, ?, ?, ?, ?)", [accountId, lead.name, lead.phone, lead.address, lead.niche]);
    }
    res.json({ success: true });
  });

  // Super Admin API
  app.get("/api/admin/accounts", async (req, res) => {
    const accounts = await currentDB.query(`
      SELECT a.*, p.name as plan_name, (SELECT COUNT(*) FROM users u WHERE u.account_id = a.id) as user_count
      FROM accounts a
      LEFT JOIN plans p ON a.plan_id = p.id
    `);
    res.json(accounts);
  });

  app.get("/api/admin/plans", async (req, res) => {
    const plans = await currentDB.query("SELECT * FROM plans");
    res.json(plans);
  });

  app.post("/api/admin/plans", async (req, res) => {
    const { name, price, max_agents, max_campaigns, max_leads, features_json } = req.body;
    const info = await currentDB.run("INSERT INTO plans (name, price, max_agents, max_campaigns, max_leads, features_json) VALUES (?, ?, ?, ?, ?, ?)", [
      name, price, max_agents, max_campaigns, max_leads, JSON.stringify(features_json)
    ]);
    res.json({ id: info.lastInsertRowid });
  });

  app.patch("/api/admin/accounts/:id/plan", async (req, res) => {
    const { plan_id } = req.body;
    await currentDB.run("UPDATE accounts SET plan_id = ? WHERE id = ?", [plan_id, req.params.id]);
    res.json({ success: true });
  });

  // Catch-all for unmatched API routes
  app.all("/api/*", (req, res) => {
    console.warn(`[404] Unmatched API Route: ${req.method} ${req.url}`);
    res.status(404).json({ error: `Route ${req.method} ${req.url} not found` });
  });

  // Seed plans
  const planCountRes = await currentDB.get("SELECT COUNT(*) as count FROM plans");
  if (planCountRes && planCountRes.count === 0) {
    await currentDB.run("INSERT INTO plans (name, price, max_agents, max_campaigns, max_leads, features_json) VALUES (?, ?, ?, ?, ?, ?)", [
      'Gratuito', 0, 1, 1, 100, JSON.stringify(['Suporte Básico', '1 Agente IA', '1 Campanha'])
    ]);
    await currentDB.run("INSERT INTO plans (name, price, max_agents, max_campaigns, max_leads, features_json) VALUES (?, ?, ?, ?, ?, ?)", [
      'Pro', 97, 5, 10, 1000, JSON.stringify(['Suporte Prioritário', '5 Agentes IA', '10 Campanhas', 'Handoff Ilimitado'])
    ]);
  }

  // Vite middleware
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, "dist")));
    app.get("*", (req, res) => {
      res.sendFile(path.join(__dirname, "dist", "index.html"));
    });
  }

  httpServer.listen(Number(PORT), "0.0.0.0", () => {
    console.log("==========================================");
    console.log(`SERVER V4 — BIDIRECTIONAL ARCHITECTURE`);
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Database: ${isSupabase ? 'Supabase' : 'SQLite'}`);
    console.log("==========================================");
  });
}

startServer();
