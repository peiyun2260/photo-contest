// Supabase 連線設定：Supabase Dashboard → Project Settings → API
// 這裡放的是 anon（public）key，本來就是公開給瀏覽器用的；資料安全靠 supabase/schema.sql 裡的權限。
// service_role key 絕對不要放在這裡。
window.CONTEST_CONFIG = {
  supabaseUrl: 'https://xsiysjvwggwboozeexot.supabase.co',
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhzaXlzanZ3Z2d3Ym9vemVleG90Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ2MzA5MjQsImV4cCI6MjExMDIwNjkyNH0.be0fD9tEONzMuCe84wIVLAuURP98iObzwRJoJk4cR0s',
};
