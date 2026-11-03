import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

export const configured =
  /^https:\/\/\S+$/.test(SUPABASE_URL) && !/YOUR-/i.test(SUPABASE_URL) && !/YOUR-/i.test(SUPABASE_ANON_KEY) && SUPABASE_ANON_KEY.length > 20;

export const sb = configured
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } })
  : null;
