import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

export const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    global: {
      fetch: (url, options) =>
        fetch(url, {
          ...options,
          signal: AbortSignal.timeout(20000) // 20s timeout
        })
    }
  }
);