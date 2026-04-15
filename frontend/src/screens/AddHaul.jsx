import { useState, useEffect } from 'preact/hooks';
import { supabase } from '../db.js';

export function AddHaul({ session }) {
  const [status, setStatus] = useState('idle'); // idle | uploading | parsing | error
  const [errorMsg, setErrorMsg] = useState(null);
  const [householdId, setHouseholdId] = useState(null);

  useEffect(() => {
    supabase
      .from('household_members')
      .select('household_id')
      .single()
      .then(({ data }) => {
        if (data) setHouseholdId(data.household_id);
      });
  }, []);

  async function handleFileChange(e) {
    const file = e.target.files?.[0];
    if (!file || !householdId) return;

    setStatus('uploading');
    setErrorMsg(null);

    // Upload photo to Supabase Storage at {userId}/{uuid}.jpg
    const ext = file.name.split('.').pop() || 'jpg';
    const path = `${session.user.id}/${crypto.randomUUID()}.${ext}`;

    const { error: uploadError } = await supabase.storage
      .from('haul-photos')
      .upload(path, file);

    if (uploadError) {
      setErrorMsg('Photo upload failed: ' + uploadError.message);
      setStatus('error');
      return;
    }

    // Insert pending_hauls row
    const { data: haul, error: haulError } = await supabase
      .from('pending_hauls')
      .insert({
        household_id: householdId,
        user_id: session.user.id,
        source: 'receipt',
        status: 'parsing',
        photo_urls: [path],
      })
      .select()
      .single();

    if (haulError) {
      setErrorMsg('Failed to create haul: ' + haulError.message);
      setStatus('error');
      return;
    }

    setStatus('parsing');

    // Call the Worker to parse the receipt
    const { data: { session: currentSession } } = await supabase.auth.getSession();
    const token = currentSession.access_token;

    const workerUrl = import.meta.env.VITE_WORKER_URL;
    let response;
    try {
      response = await fetch(`${workerUrl}/parse-haul`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ haul_id: haul.id }),
      });
    } catch (networkError) {
      setErrorMsg('Network error — check your connection and try again.');
      setStatus('error');
      return;
    }

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setErrorMsg(body.error || `Parse failed (${response.status})`);
      setStatus('error');
      return;
    }

    window.location.hash = '#hauls-inbox';
  }

  return (
    <div class="add-haul">
      <div class="screen-header">
        <a href="#inventory" class="back-link">← Back</a>
        <h2>Add Haul</h2>
      </div>

      <div class="haul-source-tabs">
        <button class="source-tab active">Receipt</button>
        <button
          class="source-tab"
          disabled
          title="Coming soon in Phase 2"
        >
          Counter Photos
        </button>
      </div>

      {status === 'idle' && (
        <div class="haul-upload-area">
          <p class="haul-hint">Photograph your receipt to add items to your inventory.</p>
          <label class="btn-primary haul-upload-btn">
            📷 Take Photo
            <input
              type="file"
              accept="image/*"
              capture="environment"
              style={{ display: 'none' }}
              onChange={handleFileChange}
              disabled={!householdId}
            />
          </label>
          <label class="btn-secondary haul-upload-btn">
            🖼 Upload Photo
            <input
              type="file"
              accept="image/*"
              style={{ display: 'none' }}
              onChange={handleFileChange}
              disabled={!householdId}
            />
          </label>
        </div>
      )}

      {status === 'uploading' && (
        <div class="haul-status">
          <div class="spinner" />
          <p>Uploading photo…</p>
        </div>
      )}

      {status === 'parsing' && (
        <div class="haul-status">
          <div class="spinner" />
          <p>Parsing receipt… this takes 5–15 seconds.</p>
        </div>
      )}

      {status === 'error' && (
        <div class="haul-upload-area">
          <p class="form-error">{errorMsg}</p>
          <label class="btn-primary haul-upload-btn">
            📷 Take Photo
            <input
              type="file"
              accept="image/*"
              capture="environment"
              style={{ display: 'none' }}
              onChange={handleFileChange}
              disabled={!householdId}
            />
          </label>
          <label class="btn-secondary haul-upload-btn">
            🖼 Upload Photo
            <input
              type="file"
              accept="image/*"
              style={{ display: 'none' }}
              onChange={handleFileChange}
              disabled={!householdId}
            />
          </label>
        </div>
      )}
    </div>
  );
}
