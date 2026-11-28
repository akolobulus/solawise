import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export type LinkedAccountProvider = "pollar" | "phantom";

export type LinkedAccount = {
  user_id: string;
  provider: LinkedAccountProvider;
  wallet_address: string;
  linked_at: string;
};

type Database = {
  public: {
    Tables: {
      linked_accounts: {
        Row: LinkedAccount;
        Insert: Omit<LinkedAccount, "linked_at"> & { linked_at?: string };
        Update: Partial<LinkedAccount>;
        Relationships: [];
      };
    };
    Views: { [_ in never]: never };
    Functions: { [_ in never]: never };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};

export type SupabaseBrowserClient = SupabaseClient<Database>;

let browserClient: SupabaseBrowserClient | null = null;

export function getSupabaseBrowserClient(): SupabaseBrowserClient | null {
  if (typeof window === "undefined") return null;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !publishableKey) return null;

  browserClient ??= createClient<Database>(url, publishableKey, {
    auth: {
      autoRefreshToken: true,
      detectSessionInUrl: true,
      persistSession: true,
    },
  });
  return browserClient;
}
