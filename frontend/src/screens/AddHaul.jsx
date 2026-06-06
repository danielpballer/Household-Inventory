import { useState, useEffect } from 'preact/hooks';
import { supabase } from '../db.js';

export function AddHaul({ session }) {
  const [activeTab, setActiveTab] = useState('receipt');
  const [status, setStatus] = useState('idle'); // idle | uploading | parsing | error
  const [errorMsg, setErrorMsg] = useState(null);
  const [householdId, setHouseholdId] = useState(null);

  // Counter photo state
  const [pendingPhotos, setPendingPhotos] = useState([]); // compressed Blobs
  const [previews, setPreviews] = useState([]);           // object URLs for thumbnails

  useEffect(() => {
    supabase
      .from('household_members')
      .select('household_id')
      .single()
      .then(({ data }) => {
        if (data) setHouseholdId(data.household_id);
      });
  }, []);

  // Revoke object URLs when previews change or component unmounts
  useEffect(() => {
    return () => previews.forEach((url) => URL.revokeObjectURL(url));
  }, [previews]);

  function switchTab(tab) {
    if (status !== 'idle') return;
    if (tab === 'receipt') {
      previews.forEach((url) => URL.revokeObjectURL(url));
      setPendingPhotos([]);
      setPreviews([]);
    }
    setErrorMsg(null);
    setActiveTab(tab);
  }

  async function compressImage(file) {
    const MAX_PX = 1800;
    const QUALITY = 0.85;
    return new Promise((resolve) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        const scale = Math.min(1, MAX_PX / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((blob) => resolve(blob), 'image/jpeg', QUALITY);
      };
      img.src = url;
    });
  }

  async function callWorker(haulId) {
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
        body: JSON.stringify({ haul_id: haulId }),
      });
    } catch {
      throw new Error('Network error — check your connection and try again.');
    }
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `Parse failed (${response.status})`);
    }
  }

  // ---- Receipt tab ----

  async function handleReceiptFileChange(e) {
    const file = e.target.files?.[0];
    if (!file || !householdId) return;

    setStatus('uploading');
    setErrorMsg(null);

    const compressed = await compressImage(file);
    const path = `${session.user.id}/${crypto.randomUUID()}.jpg`;

    const { error: uploadError } = await supabase.storage
      .from('haul-photos')
      .upload(path, compressed, { contentType: 'image/jpeg' });

    if (uploadError) {
      setErrorMsg('Photo upload failed: ' + uploadError.message);
      setStatus('error');
      return;
    }

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

    try {
      await callWorker(haul.id);
    } catch (err) {
      setErrorMsg(err.message);
      setStatus('error');
      return;
    }

    window.location.hash = '#hauls-inbox';
  }

  // ---- Counter Photos tab ----

  async function handleCounterFileChange(e) {
    const file = e.target.files?.[0];
    if (!file || pendingPhotos.length >= 5) return;
    e.target.value = '';
    const compressed = await compressImage(file);
    const preview = URL.createObjectURL(compressed);
    setPendingPhotos((prev) => [...prev, compressed]);
    setPreviews((prev) => [...prev, preview]);
  }

  function removePhoto(index) {
    URL.revokeObjectURL(previews[index]);
    setPendingPhotos((prev) => prev.filter((_, i) => i !== index));
    setPreviews((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleCounterSubmit() {
    if (pendingPhotos.length === 0 || !householdId) return;

    setStatus('uploading');
    setErrorMsg(null);

    const paths = [];
    for (const photo of pendingPhotos) {
      const path = `${session.user.id}/${crypto.randomUUID()}.jpg`;
      const { error: uploadError } = await supabase.storage
        .from('haul-photos')
        .upload(path, photo, { contentType: 'image/jpeg' });
      if (uploadError) {
        setErrorMsg('Photo upload failed: ' + uploadError.message);
        setStatus('error');
        return;
      }
      paths.push(path);
    }

    const { data: haul, error: haulError } = await supabase
      .from('pending_hauls')
      .insert({
        household_id: householdId,
        user_id: session.user.id,
        source: 'counter_photo',
        status: 'parsing',
        photo_urls: paths,
      })
      .select()
      .single();

    if (haulError) {
      setErrorMsg('Failed to create haul: ' + haulError.message);
      setStatus('error');
      return;
    }

    setStatus('parsing');

    try {
      await callWorker(haul.id);
    } catch (err) {
      setErrorMsg(err.message);
      setStatus('error');
      return;
    }

    window.location.hash = '#hauls-inbox';
  }

  // ---- Render ----

  const busy = status === 'uploading' || status === 'parsing';

  return (
    <div class="add-haul">
      <div class="screen-header">
        <a href="#inventory" class="back-link">← Back</a>
        <h2>Add Haul</h2>
      </div>

      <div class="haul-source-tabs">
        <button
          class={`source-tab ${activeTab === 'receipt' ? 'active' : ''}`}
          onClick={() => switchTab('receipt')}
          disabled={busy}
        >
          Receipt
        </button>
        <button
          class={`source-tab ${activeTab === 'counter' ? 'active' : ''}`}
          onClick={() => switchTab('counter')}
          disabled={busy}
        >
          Counter Photos
        </button>
      </div>

      {status === 'uploading' && (
        <div class="haul-status">
          <div class="spinner" />
          <p>Uploading photo{activeTab === 'counter' && pendingPhotos.length > 1 ? 's' : ''}…</p>
        </div>
      )}

      {status === 'parsing' && (
        <div class="haul-status">
          <div class="spinner" />
          <p>
            {activeTab === 'counter'
              ? 'Analyzing pantry photos… this takes 15–30 seconds.'
              : 'Parsing receipt… this takes 5–15 seconds.'}
          </p>
        </div>
      )}

      {!busy && activeTab === 'receipt' && (
        <div class="haul-upload-area">
          {status === 'error' && <p class="form-error">{errorMsg}</p>}
          <p class="haul-hint">Photograph your receipt to add items to your inventory.</p>
          <label class="btn-primary haul-upload-btn">
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M1.5 8a1.5 1.5 0 011.5-1.5h1.25L5.5 5h7l1.25 1.5H15a1.5 1.5 0 011.5 1.5v7A1.5 1.5 0 0115 15H3A1.5 1.5 0 011.5 13.5V8z"/>
              <circle cx="9" cy="11" r="2.5"/>
            </svg>
            Take Photo
            <input
              type="file"
              accept="image/*"
              capture="environment"
              style={{ display: 'none' }}
              onChange={handleReceiptFileChange}
              disabled={!householdId}
            />
          </label>
          <label class="btn-secondary haul-upload-btn">
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect x="1.5" y="2.5" width="15" height="13" rx="2"/>
              <circle cx="6" cy="7" r="1.75"/>
              <path d="M1.5 13l4-4.5 3.5 4 2.5-2.5 4.5 4.5"/>
            </svg>
            Upload Photo
            <input
              type="file"
              accept="image/*"
              style={{ display: 'none' }}
              onChange={handleReceiptFileChange}
              disabled={!householdId}
            />
          </label>
        </div>
      )}

      {!busy && activeTab === 'counter' && (
        <div class="haul-upload-area">
          {status === 'error' && <p class="form-error">{errorMsg}</p>}
          <p class="haul-hint">
            Photograph your pantry shelves, fridge, or cabinets. Add up to 5 photos, then tap Analyze.
          </p>

          {previews.length > 0 && (
            <div class="photo-previews">
              {previews.map((src, i) => (
                <div key={i} class="photo-preview">
                  <img src={src} alt={`Photo ${i + 1}`} />
                  <button
                    class="photo-remove-btn"
                    onClick={() => removePhoto(i)}
                    aria-label={`Remove photo ${i + 1}`}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}

          {pendingPhotos.length < 5 && (
            <>
              <label class="btn-primary haul-upload-btn">
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M1.5 8a1.5 1.5 0 011.5-1.5h1.25L5.5 5h7l1.25 1.5H15a1.5 1.5 0 011.5 1.5v7A1.5 1.5 0 0115 15H3A1.5 1.5 0 011.5 13.5V8z"/>
                  <circle cx="9" cy="11" r="2.5"/>
                </svg>
                Take Photo
                <input
                  type="file"
                  accept="image/*"
                  capture="environment"
                  style={{ display: 'none' }}
                  onChange={handleCounterFileChange}
                  disabled={!householdId}
                />
              </label>
              <label class="btn-secondary haul-upload-btn">
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <rect x="1.5" y="2.5" width="15" height="13" rx="2"/>
                  <circle cx="6" cy="7" r="1.75"/>
                  <path d="M1.5 13l4-4.5 3.5 4 2.5-2.5 4.5 4.5"/>
                </svg>
                Upload Photo
                <input
                  type="file"
                  accept="image/*"
                  style={{ display: 'none' }}
                  onChange={handleCounterFileChange}
                  disabled={!householdId}
                />
              </label>
            </>
          )}

          {pendingPhotos.length > 0 && (
            <button class="btn-primary haul-upload-btn" onClick={handleCounterSubmit}>
              Analyze Pantry ({pendingPhotos.length} photo{pendingPhotos.length !== 1 ? 's' : ''})
            </button>
          )}
        </div>
      )}
    </div>
  );
}
