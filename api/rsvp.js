const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);
const SITE_URL = (process.env.SITE_URL || 'https://knoepplers.de').replace(/\/$/, '');
const FROM_EMAIL = process.env.RSVP_FROM_EMAIL || 'Ira & Josias <hochzeit@knoepplers.de>';

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

module.exports = async (req, res) => {
  // ---------- GET: look up an existing RSVP by magic-link token ----------
  if (req.method === 'GET') {
    const token = (req.query.token || '').toString().trim();
    if (!token) return res.status(400).json({ error: 'token required' });

    const { data: rsvp, error } = await supabase
      .from('rsvps')
      .select('id, name, email, attending, message')
      .eq('edit_token', token)
      .maybeSingle();

    if (error || !rsvp) return res.status(404).json({ error: 'not found' });

    const { data: guests } = await supabase
      .from('rsvp_guests')
      .select('guest_type, name, diet, allergies')
      .eq('rsvp_id', rsvp.id);

    return res.status(200).json({
      name: rsvp.name,
      email: rsvp.email,
      attending: rsvp.attending,
      message: rsvp.message || '',
      guests: (guests || []).map(g => ({
        type: g.guest_type,
        name: g.name,
        diet: g.diet,
        allergies: g.allergies || ''
      }))
    });
  }

  // ---------- POST: create or update an RSVP, then email a confirmation ----------
  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { body = {}; }
    }
    const { token, name, email, attending, message, guests, note_ref } = body || {};

    // Honeypot: this hidden field is invisible to real guests and named so it
    // doesn't match any real autofill category. Any bot that fills it gets a
    // fake "success" so it moves on without touching the DB.
    if (note_ref) {
      return res.status(200).json({ ok: true });
    }

    if (!name || !isValidEmail(email) || typeof attending !== 'boolean') {
      return res.status(400).json({ error: 'missing or invalid fields' });
    }

    if (
      name.length > 120 ||
      email.length > 200 ||
      (message && message.length > 2000) ||
      (Array.isArray(guests) && guests.length > 30) ||
      (Array.isArray(guests) && guests.some(g => g && ((g.name || '').length > 120 || (g.allergies || '').length > 500)))
    ) {
      return res.status(400).json({ error: 'input too long' });
    }

    let rsvpId, editToken;

    if (token) {
      // Editing an existing RSVP via magic link
      const { data: existing, error: findErr } = await supabase
        .from('rsvps')
        .select('id, edit_token')
        .eq('edit_token', token)
        .maybeSingle();
      if (findErr || !existing) return res.status(404).json({ error: 'invalid token' });

      rsvpId = existing.id;
      editToken = existing.edit_token;

      const { error: updateErr } = await supabase
        .from('rsvps')
        .update({ name, email, attending, message: message || null, updated_at: new Date().toISOString() })
        .eq('id', rsvpId);
      if (updateErr) return res.status(500).json({ error: 'update failed' });

      await supabase.from('rsvp_guests').delete().eq('rsvp_id', rsvpId);
    } else {
      // New submission — upsert by email so an accidental second submit
      // updates the same record instead of erroring on the unique constraint
      const { data: existingByEmail } = await supabase
        .from('rsvps')
        .select('id, edit_token')
        .ilike('email', email)
        .maybeSingle();

      if (existingByEmail) {
        rsvpId = existingByEmail.id;
        editToken = existingByEmail.edit_token;
        await supabase
          .from('rsvps')
          .update({ name, attending, message: message || null, updated_at: new Date().toISOString() })
          .eq('id', rsvpId);
        await supabase.from('rsvp_guests').delete().eq('rsvp_id', rsvpId);
      } else {
        const { data: created, error: createErr } = await supabase
          .from('rsvps')
          .insert({ name, email, attending, message: message || null })
          .select('id, edit_token')
          .single();
        if (createErr) return res.status(500).json({ error: 'create failed' });
        rsvpId = created.id;
        editToken = created.edit_token;
      }
    }

    if (attending && Array.isArray(guests) && guests.length > 0) {
      const rows = guests
        .filter(g => g && g.name && ['adult', 'kid', 'baby'].includes(g.type))
        .map(g => ({
          rsvp_id: rsvpId,
          guest_type: g.type,
          name: g.name,
          diet: g.type === 'baby' ? null : (g.diet || 'none'),
          allergies: g.allergies || null
        }));
      if (rows.length > 0) {
        const { error: guestsErr } = await supabase.from('rsvp_guests').insert(rows);
        if (guestsErr) return res.status(500).json({ error: 'guests failed' });
      }
    }

    const editUrl = `${SITE_URL}/?token=${editToken}#rsvp`;

    try {
      await resend.emails.send({
        from: FROM_EMAIL,
        to: email,
        subject: attending ? 'Eure Anmeldung ist da!' : 'Danke für eure Rückmeldung',
        text: attending
          ? `Hallo ${name},\n\nwir haben eure Anmeldung erhalten – wir freuen uns riesig, dass ihr dabei seid!\n\nFalls sich noch etwas ändert, könnt ihr eure Angaben hier jederzeit anpassen:\n${editUrl}\n\nBis bald auf der Ranch!\nIra & Josias`
          : `Hallo ${name},\n\nschade, dass ihr nicht dabei sein könnt – danke für die Rückmeldung!\n\nFalls sich das noch ändert, könnt ihr hier jederzeit umentscheiden:\n${editUrl}\n\nLiebe Grüße\nIra & Josias`
      });
    } catch (mailErr) {
      // The RSVP itself is already saved — a failed mail shouldn't fail the whole request.
      console.error('Resend send failed:', mailErr);
    }

    return res.status(200).json({ ok: true });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'method not allowed' });
};
