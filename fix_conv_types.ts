
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
dotenv.config();

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function fix() {
  console.log("Fixing conversation types...");
  
  // Update groups
  const { error: groupError, count: groupCount } = await supabase
    .from('conversations')
    .update({ type: 'group' })
    .not('group_jid', 'is', null)
    .is('type', null);
    
  if (groupError) console.error("Error updating groups:", groupError.message);
  else console.log(`Updated groups count: ${groupCount}`);

  // Update contacts
  const { error: contactError, count: contactCount } = await supabase
    .from('conversations')
    .update({ type: 'contact' })
    .is('group_jid', null)
    .is('type', null);

  if (contactError) console.error("Error updating contacts:", contactError.message);
  else console.log(`Updated contacts count: ${contactCount}`);
  
  console.log("Fix done.");
}

fix();
