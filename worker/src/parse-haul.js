/**
 * /parse-haul route handler.
 *
 * Flow:
 *   1. Validate request body (haul_id required)
 *   2. Fetch pending_hauls row and verify household membership (IDOR guard)
 *   3. Check status == 'parsing' (idempotency guard)
 *   4. Download photos from Supabase Storage using service_role key
 *   5. Call Anthropic Haiku with few-shot receipt parsing prompt
 *   6. Update pending_hauls to status='ready' with parsed_items
 *   7. Record usage in usage_meter
 */

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const RECEIPT_MODEL = 'claude-haiku-4-5-20251001';

// Haiku pricing as of 2026-04
const COST_PER_INPUT_TOKEN = 0.0000008; // $0.80 / 1M tokens
const COST_PER_OUTPUT_TOKEN = 0.000004; // $4.00 / 1M tokens

// ---------------------------------------------------------------------------
// System prompt — few-shot examples built from real Whole Foods, Trader Joe's,
// and Costco receipts. Update examples here when parsing quality degrades.
// ---------------------------------------------------------------------------
const RECEIPT_SYSTEM_PROMPT = `You are a grocery receipt parser for a household inventory app.

## Task
Extract purchasable household items from the receipt image. Return ONLY a valid JSON array — no explanation, no markdown code fences, no other text.

## Output format
Each element in the array:
{"name": "Human-readable item name", "category": "Category", "quantity": integer, "confidence": "high|medium|low"}

## Categories (use exactly one of these values)
Produce, Dairy, Pantry, Frozen, Meat, Beverages, Household, Other

## Rules
1. SKIP these line types entirely: savings/discounts, tare weights, container deposits, subtotals, taxes, totals, payment info, loyalty program notes, store addresses, cashier names.
2. SKIP non-consumable items (e.g., reusable bags).
3. Expand abbreviations to human-readable names (see patterns below).
4. Remove brand code prefixes (e.g., "365WFM", "GRPCOM", "VTLFR", "ASPN", "LBPLATF") and brand names (e.g., "Kirkland", "Vital Farms", "Creminelli", "King Arthur", "Driscoll's", "Asmar's"). Use the generic product name only. Exception: keep the brand only when the product is not recognizable without it (e.g., "Cafe Cubano", "Parmigiano Reggiano", "Heavenly Hunks").
5. Drop "Organic" from all item names. Use just the product name (e.g., "Red Onion" not "Organic Red Onion").
6. Quantity: use the count shown ("4 @" = 4, "Qty 2" = 2, "Qty 3 Reg" = 3). Default to 1 when not specified. For weight-sold items (e.g., "1.32 lb @ $2.69/lb"), quantity = 1.
7. Confidence: high = clearly readable name, medium = interpreted from abbreviations with reasonable certainty, low = significant guessing required.

## Whole Foods abbreviation guide
OG = Organic
365WFM = 365 Whole Foods Market (store brand — drop prefix, keep product)
TRKLSP = Trickling Springs (brand — drop prefix)
GRPCOM = Grapevine (brand — drop prefix)
VTLFR = Vital Farms (brand — keep as "Vital Farms")
ASPN = Aspen (brand — drop prefix)
LBPLATF / LBLATF = Liberty or similar egg brand — drop prefix
CRMNI = Creminelli (keep as "Creminelli")
KINGA = King Arthur (keep as "King Arthur")
ASMAR = Asmar's (keep as "Asmar's")
CHOSEN TOO PCT = Chosen Foods 100% Pure
DSCL = Driscoll's (keep as "Driscoll's")
SUNSET = Sunset (keep as "Sunset")
HMEN = Homogenized
WL MLK = Whole Milk
GN = Gallon
SOLS = Seedless
STRNG = String
CHS = Cheese
MOZ = Mozzarella
CHRY / CHRIY = Cherry
ANG = Angel (as in Angel Tomatoes)
SLCD = Sliced
LG = Large
PR = Pasture Raised
BRWN = Brown
CHCKN = Chicken
BRST = Breast
GRO A = Grade A

## Costco abbreviation guide
KS = Kirkland Signature (store brand — keep as "Kirkland")
ORG / OG = Organic
KS PNUT BUTR = Kirkland Peanut Butter
KS SOCKEYE = Kirkland Sockeye Salmon
KS DENTAL CH = Kirkland Dental Chews (pet product — category: Household)
DUBLINER CHS = Dubliner Cheese
REGGIANO = Parmigiano Reggiano
GOAT LOG = Goat Cheese Log
CAFE CUBANO = Cafe Cubano (coffee)
HEAVENLY HNK = Heavenly Hunks (oat bites)
THAT'S IT = That's It (fruit bars)
HRSHY KISSES = Hershey's Kisses
SUPER VEGGIE = Super Veggie blend
ORG STRAWBRY = Organic Strawberries
ZIPLOC GAL = Ziploc Gallon Bags (category: Household)
REYNOLDS FOIL = Reynolds Aluminum Foil (category: Household)
BAGEL CHIPS = Bagel Chips
MANDARINS = Mandarins
BEEFSTICKS = Beef Sticks
SKIP at Costco: items that are clearly non-consumable (razors, nozzle sets, tools).
IMPORTANT at Costco: if the same item name appears on multiple consecutive lines, that means multiple units were purchased — set quantity to the count of those lines, not 1.

## Example 1 — Trader Joe's (quantity from "N @ price" format)

Receipt lines:
WHOLE MILK MOZZARELLA   4 @ $5.29   $21.96
Items in Transaction: 4

Output:
[{"name": "Whole Milk Mozzarella", "category": "Dairy", "quantity": 4, "confidence": "high"}]

## Example 2 — Whole Foods (abbreviations, skip lines, drop "Organic" and brands)

Receipt lines:
TRKLSP OG HMEN WL MLK GN    F  $15.39
CONTAINER DEPOSIT                $3.00
CHOSEN TOO PCT AVOCADO OIL   F  $13.99
Savings with Prime ($4.26)
SUNSET OG CHRY ANG TOMATO    F   $6.79
KOLOS OG SHEP FETA           F  $16.98
Savings with Prime ($2.29)
OG RED ONION          ea
Tare Weight 0.01 lb
OG BABY BROCCOLI             F   $3.87
GRPCOM OG RED SOLS GRAPES    Qty 2 Reg $3.99   $6.49
365WFM OG MOZ STRNG CHS      F   $6.00
ASPN OG CHCKN BRST           F  $17.47
CANTALOUPE                   F   $3.50
VTLFR OG L GRO A EGG         Qty 2 @ $10.99   $21.98
LBPLATF OG LG PR BROWN EGG   F  $16.98
FRUIT MIX                    F  $25.58

Output:
[
  {"name": "Whole Milk (Gallon)", "category": "Dairy", "quantity": 1, "confidence": "medium"},
  {"name": "Avocado Oil", "category": "Pantry", "quantity": 1, "confidence": "high"},
  {"name": "Cherry Angel Tomatoes", "category": "Produce", "quantity": 1, "confidence": "medium"},
  {"name": "Sheep Feta", "category": "Dairy", "quantity": 1, "confidence": "high"},
  {"name": "Red Onion", "category": "Produce", "quantity": 1, "confidence": "high"},
  {"name": "Baby Broccoli", "category": "Produce", "quantity": 1, "confidence": "high"},
  {"name": "Red Seedless Grapes", "category": "Produce", "quantity": 2, "confidence": "high"},
  {"name": "Mozzarella String Cheese", "category": "Dairy", "quantity": 1, "confidence": "high"},
  {"name": "Chicken Breast", "category": "Meat", "quantity": 1, "confidence": "high"},
  {"name": "Cantaloupe", "category": "Produce", "quantity": 1, "confidence": "high"},
  {"name": "Large Grade A Eggs", "category": "Dairy", "quantity": 2, "confidence": "high"},
  {"name": "Large Pasture-Raised Brown Eggs", "category": "Dairy", "quantity": 1, "confidence": "medium"},
  {"name": "Fruit Mix", "category": "Produce", "quantity": 1, "confidence": "high"}
]

## Example 3 — Whole Foods (more items, weight-priced produce = qty 1)

Receipt lines:
KINGA OG FLOURS              F  $11.49
CRMNI SLCD PEPPERONI         Qty 3 Reg $5.69   $11.49
DSCL OG STRAWBERRY           F   $9.99
365WFM OG HIGH ORG MLK       F  $11.08
ASMAR ORIGINAL HUMMUS        F   $6.49
GRPCOM OG RED SOLS GRAPES    Qty 2 Reg $3.00    $6.46
OG YELLOW ONION              2.47 lb @ $2.69/lb  $6.64
Tare Weight 0.01 lb
OG ORANGE BELL PEPPER        1.32 lb @ $2.69/lb
Savings with Prime ($2.14)
OG RED ONION                 2.13 lb @ $3.99/lb  $3.55
OG LG PR BRWN EGG            F   $6.36

Output:
[
  {"name": "Flour", "category": "Pantry", "quantity": 1, "confidence": "high"},
  {"name": "Sliced Pepperoni", "category": "Meat", "quantity": 3, "confidence": "high"},
  {"name": "Strawberries", "category": "Produce", "quantity": 1, "confidence": "high"},
  {"name": "Whole Milk", "category": "Dairy", "quantity": 1, "confidence": "high"},
  {"name": "Original Hummus", "category": "Pantry", "quantity": 1, "confidence": "high"},
  {"name": "Red Seedless Grapes", "category": "Produce", "quantity": 2, "confidence": "high"},
  {"name": "Yellow Onion", "category": "Produce", "quantity": 1, "confidence": "high"},
  {"name": "Orange Bell Pepper", "category": "Produce", "quantity": 1, "confidence": "high"},
  {"name": "Red Onion", "category": "Produce", "quantity": 1, "confidence": "high"},
  {"name": "Large Pasture-Raised Brown Eggs", "category": "Dairy", "quantity": 1, "confidence": "high"}
]

## Example 4 — Costco (repeated lines = multiple units, skip non-consumables)

Receipt lines:
512515 ORG STRAWBRY          E   8.59
555000 KS PNUT BUTR          E   9.79
555000 KS PNUT BUTR          E   9.79
1258564 BEEFSTICKS           E  17.99
1258564 BEEFSTICKS           E  17.99
1801 MANDARINS               E   5.29
9090 GOAT LOG                E   8.29
9090 GOAT LOG                E   8.29
112213 CAFE CUBANO           E  17.99
112213 CAFE CUBANO           E  17.99
112213 CAFE CUBANO           E  17.99
112213 CAFE CUBANO           E  17.99
1897217 ZIPLOC GAL           E  13.79 A
34777 REGGIANO               E  17.89
0000374678 HEAVENLY HNK      E   5.00 A
221177 KS SOCKEYE            E   3.30
1933983 3PCNOZZLESET         E  14.04 A
555000 VENUS                 E  34.99 A
401055 HRSHY KISSES          E   7.59
1361170 THAT'S IT            E  39.99

Output:
[
  {"name": "Strawberries", "category": "Produce", "quantity": 1, "confidence": "high"},
  {"name": "Peanut Butter", "category": "Pantry", "quantity": 2, "confidence": "high"},
  {"name": "Beef Sticks", "category": "Meat", "quantity": 2, "confidence": "high"},
  {"name": "Mandarins", "category": "Produce", "quantity": 1, "confidence": "high"},
  {"name": "Goat Cheese Log", "category": "Dairy", "quantity": 2, "confidence": "high"},
  {"name": "Cafe Cubano", "category": "Beverages", "quantity": 4, "confidence": "high"},
  {"name": "Gallon Zip Bags", "category": "Household", "quantity": 1, "confidence": "high"},
  {"name": "Parmigiano Reggiano", "category": "Dairy", "quantity": 1, "confidence": "high"},
  {"name": "Heavenly Hunks", "category": "Pantry", "quantity": 1, "confidence": "high"},
  {"name": "Sockeye Salmon", "category": "Meat", "quantity": 1, "confidence": "high"},
  {"name": "Chocolate Kisses", "category": "Pantry", "quantity": 1, "confidence": "high"},
  {"name": "Fruit Bars", "category": "Pantry", "quantity": 1, "confidence": "high"}
]`;

// ---------------------------------------------------------------------------
// Route handler (called from index.js after auth + spend cap + rate limit)
// ---------------------------------------------------------------------------
export async function handleParseHaul(request, env, user) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { haul_id } = body;
  if (!haul_id) {
    return Response.json({ error: 'haul_id is required' }, { status: 400 });
  }

  // 1. Fetch the haul row
  const haul = await fetchHaul(haul_id, env);
  if (!haul) {
    return Response.json({ error: 'Haul not found' }, { status: 404 });
  }

  // 2. IDOR guard — verify the requesting user belongs to this haul's household
  const member = await isHouseholdMember(user.id, haul.household_id, env);
  if (!member) {
    return Response.json({ error: 'Not authorized' }, { status: 403 });
  }

  // 3. Idempotency — only parse hauls in 'parsing' state
  if (haul.status !== 'parsing') {
    return Response.json(
      { error: `Haul status is '${haul.status}', expected 'parsing'` },
      { status: 409 },
    );
  }

  // 4. Download photos from Supabase Storage
  let photos;
  try {
    photos = await downloadPhotos(haul.photo_urls, env);
  } catch (err) {
    await setHaulFailed(haul_id, err.message, env);
    return Response.json({ error: 'Failed to download photos', detail: err.message }, { status: 502 });
  }

  // 5. Call Anthropic API
  let parsedItems, usage;
  try {
    const result = await callAnthropic(photos, env);
    parsedItems = result.items;
    usage = result.usage;
  } catch (err) {
    await setHaulFailed(haul_id, err.message, env);
    return Response.json({ error: 'Parsing failed', detail: err.message }, { status: 502 });
  }

  // 6. Update haul to 'ready'
  await patchHaul(haul_id, { status: 'ready', parsed_items: parsedItems }, env);

  // 7. Record usage (non-blocking — don't fail the request if this errors)
  recordUsage(user.id, usage, env).catch((err) =>
    console.error('recordUsage failed:', err.message),
  );

  return Response.json({ ok: true, item_count: parsedItems.length });
}

// ---------------------------------------------------------------------------
// Supabase helpers
// ---------------------------------------------------------------------------

function supabaseHeaders(env) {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
  };
}

async function fetchHaul(haulId, env) {
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/pending_hauls?id=eq.${haulId}&select=*`,
    { headers: supabaseHeaders(env) },
  );
  const rows = await res.json();
  return rows[0] ?? null;
}

async function isHouseholdMember(userId, householdId, env) {
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/household_members` +
      `?user_id=eq.${userId}&household_id=eq.${householdId}&select=household_id`,
    { headers: supabaseHeaders(env) },
  );
  const rows = await res.json();
  return rows.length > 0;
}

async function downloadPhotos(photoUrls, env) {
  return Promise.all(
    photoUrls.map(async (path) => {
      const res = await fetch(
        `${env.SUPABASE_URL}/storage/v1/object/haul-photos/${path}`,
        { headers: supabaseHeaders(env) },
      );
      if (!res.ok) {
        throw new Error(`Storage download failed for ${path}: HTTP ${res.status}`);
      }
      const buffer = await res.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return {
        base64: btoa(binary),
        mediaType: res.headers.get('content-type') ?? 'image/jpeg',
      };
    }),
  );
}

async function patchHaul(haulId, fields, env) {
  await fetch(`${env.SUPABASE_URL}/rest/v1/pending_hauls?id=eq.${haulId}`, {
    method: 'PATCH',
    headers: { ...supabaseHeaders(env), 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  });
}

async function setHaulFailed(haulId, errorMessage, env) {
  await patchHaul(
    haulId,
    { status: 'failed', parsed_items: [{ error: errorMessage }] },
    env,
  );
}

async function recordUsage(userId, { inputTokens, outputTokens }, env) {
  const cost = inputTokens * COST_PER_INPUT_TOKEN + outputTokens * COST_PER_OUTPUT_TOKEN;
  const today = new Date().toISOString().slice(0, 10);
  const baseHeaders = { ...supabaseHeaders(env), 'Content-Type': 'application/json' };

  // Fetch existing row for today
  const getRes = await fetch(
    `${env.SUPABASE_URL}/rest/v1/usage_meter` +
      `?user_id=eq.${userId}&date=eq.${today}&select=id,parse_count,estimated_cost_usd`,
    { headers: supabaseHeaders(env) },
  );
  const rows = await getRes.json();

  if (rows.length > 0) {
    const row = rows[0];
    await fetch(`${env.SUPABASE_URL}/rest/v1/usage_meter?id=eq.${row.id}`, {
      method: 'PATCH',
      headers: baseHeaders,
      body: JSON.stringify({
        parse_count: row.parse_count + 1,
        estimated_cost_usd: parseFloat(row.estimated_cost_usd) + cost,
      }),
    });
  } else {
    await fetch(`${env.SUPABASE_URL}/rest/v1/usage_meter`, {
      method: 'POST',
      headers: baseHeaders,
      body: JSON.stringify({
        user_id: userId,
        date: today,
        parse_count: 1,
        estimated_cost_usd: cost,
      }),
    });
  }
}

// ---------------------------------------------------------------------------
// Anthropic API
// ---------------------------------------------------------------------------

async function callAnthropic(photos, env) {
  const imageBlocks = photos.map(({ base64, mediaType }) => ({
    type: 'image',
    source: { type: 'base64', media_type: mediaType, data: base64 },
  }));

  const res = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: RECEIPT_MODEL,
      max_tokens: 2048,
      system: RECEIPT_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            ...imageBlocks,
            { type: 'text', text: 'Parse this receipt. Return only the JSON array.' },
          ],
        },
      ],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  const rawText = data.content?.[0]?.text ?? '[]';

  // Strip markdown code fences if Haiku wraps the output
  const cleaned = rawText
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  let items;
  try {
    items = JSON.parse(cleaned);
    if (!Array.isArray(items)) items = [];
  } catch {
    // If parsing fails, return empty — frontend will show 0 items to review
    console.error('Failed to parse Anthropic response as JSON:', rawText);
    items = [];
  }

  return {
    items,
    usage: {
      inputTokens: data.usage?.input_tokens ?? 0,
      outputTokens: data.usage?.output_tokens ?? 0,
    },
  };
}
