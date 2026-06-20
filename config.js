// IIP dashboard config.
// The anon key is PUBLIC by design — it is safe to ship in a static page because
// Row Level Security locks all data to the authenticated owner (see
// supabase/migrations/0003_enable_rls.sql). Without a valid owner login, this key
// returns nothing.
window.IIP_CONFIG = {
  SUPABASE_URL: "https://uuabfjldpkaehsreubrv.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV1YWJmamxkcGthZWhzcmV1YnJ2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE5NjEzMjYsImV4cCI6MjA5NzUzNzMyNn0.Q-Pn5lANdhGAcFlDD0Bwzv-S4ll7cWhLbzwHyH5PC-Q",
};
