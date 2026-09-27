const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

module.exports = async (req, res) => {
  // Vercel signs its own cron requests with this header — reject anything else
  // so no one else can spam this endpoint.
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const { error } = await supabase.from('rsvps').select('id').limit(1);
  if (error) return res.status(500).json({ ok: false, error: error.message });

  return res.status(200).json({ ok: true, pingedAt: new Date().toISOString() });
};
