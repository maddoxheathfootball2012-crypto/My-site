# EBAAD Recipient Deployment Guide (Hybrid GCS + Vercel Architecture)

This guide provides step-by-step instructions for deploying the website using a **Hybrid Google Cloud Storage (Frontend) + Vercel (Serverless Backend)** architecture.

---

## Architecture Overview

* **Frontend (Google Cloud Storage):** Hosts public static assets and the client interface, providing the public entry URL.
* **Backend Runtime (Vercel Serverless):** Runs the secure Node.js serverless backend, maintains EBAAD Shield licence validation, and handles runtime decryption of protected application packages.
* **Proxy Transport (Wisp):** Direct browser-to-server WebSocket proxy transport via `wss://studynestlab.org/wisp/`.
* **Zero VPS Required:** Completely serverless on both GCP and Vercel.

```
┌────────────────────────────────────────────────────────┐
│                     USER BROWSER                       │
└───────────────┬───────────────────────┬────────────────┘
                │ 1. Public UI & Assets │ 3. Direct Wisp WebSocket
                ▼                       ▼
  ┌────────────────────────┐    ┌───────────────────────────┐
  │  Google Cloud Storage  │    │      Wisp Proxy Node      │
  │     (Static Bucket)    │    │ wss://studynestlab.org/   │
  └────────────────────────┘    └───────────────────────────┘
                │
                │ 2. Authenticated API & Protected Routes
                ▼
  ┌────────────────────────┐
  │     Vercel Backend     │
  │  (Serverless EBAAD)    │
  └─────────────┬──────────┘
                │ Periodic Validation
                ▼
  ┌────────────────────────┐
  │ Production Licence API │
  │ ebaad-licence-service  │
  └────────────────────────┘
```

> [!IMPORTANT]
> **Strict Security Rules:**
> 1. **Do not decrypt or inspect `app.ebaad`.** It is an encrypted binary protected by AES-256-GCM.
> 2. **Never upload decrypted proprietary code to Google Cloud Storage.** All proprietary application logic must remain exclusively inside `app.ebaad` on the Vercel backend.
> 3. **Master keys and private signing keys are strictly server-side.** You do not need or have access to any master keys or private keys.

---

## Step 1: Create a Google Cloud Project

1. Open the [Google Cloud Console](https://console.cloud.google.com/).
2. Click the project dropdown in the top navigation bar and select **New Project**.
3. Enter a Project Name (e.g. `blueberri-frontend`) and click **Create**.
4. Make sure your newly created project is selected in the console header.

*(Optional CLI command:)*
```bash
gcloud projects create your-project-id --set-as-default
```

---

## Step 2: Create a Google Cloud Storage Bucket

1. In the Google Cloud Console, navigate to **Cloud Storage > Buckets**.
2. Click **Create**.
3. Configure the bucket settings:
   * **Bucket Name:** Enter a globally unique name (e.g. `blueberri-site-YOURNAME` or your custom domain name).
   * **Location Type:** Select **Multi-region** (e.g. `us` or `eu`) or a single region near your primary audience.
   * **Storage Class:** Select **Standard**.
   * **Public Access Prevention:** **Uncheck** "Enforce public access prevention on this bucket" (this allows the bucket to host public web content).
   * **Access Control:** Select **Uniform**.
4. Click **Create**.

*(Optional CLI command:)*
```bash
gcloud storage buckets create gs://YOUR_BUCKET_NAME --location=US --uniform-bucket-level-access
```

---

## Step 3: Upload Static Frontend Files to Google Cloud Storage

Upload only the public frontend assets (such as images, icons, and public client assets) to the bucket.

1. In your bucket page, click **Upload Folder** or **Upload Files**.
2. Select the public static assets directory.
3. Keep the file structure intact (e.g. `/assets/...`, `/images/...`).

*(Optional CLI command:)*
```bash
gcloud storage cp -r ./public_assets/* gs://YOUR_BUCKET_NAME/
```

> [!CAUTION]
> **Do not upload `app.ebaad`, `server.mjs`, or `public.pem` to Google Cloud Storage.** Those files belong strictly on Vercel.

---

## Step 4: Configure Website Entry and Error Pages

1. In the **Cloud Storage > Buckets** list, click the three-dots menu (⋮) next to your bucket name.
2. Select **Edit website configuration**.
3. Set:
   * **Main page suffix:** `index.html`
   * **404 (Not Found) page:** `index.html` (or `404.html` if available)
4. Click **Save**.

*(Optional CLI command:)*
```bash
gcloud storage buckets update gs://YOUR_BUCKET_NAME --web-main-page-suffix=index.html --web-error-page=index.html
```

---

## Step 5: Configure Public Access on the Bucket

Make the static assets publicly readable by website visitors:

1. Click on your bucket name and go to the **Permissions** tab.
2. Click **Grant Access**.
3. Under **Add principals**, enter: `allUsers`
4. Under **Assign roles**, select **Storage Object Viewer** (`roles/storage.objectViewer`).
5. Click **Save** and confirm **Allow Public Access**.

*(Optional CLI command:)*
```bash
gcloud storage buckets add-iam-policy-binding gs://YOUR_BUCKET_NAME --member=allUsers --role=roles/storage.objectViewer
```

---

## Step 6: Obtain the Public Website URL

Your Google Cloud Storage static website is accessible at:

* **Direct GCS URL:** `https://storage.googleapis.com/YOUR_BUCKET_NAME/index.html`
* **GCS Web Endpoint:** `http://YOUR_BUCKET_NAME.storage.googleapis.com/index.html`

Test this URL in your web browser to confirm your static entry page loads.

---

## Step 7: Deploy the Vercel Serverless Backend

The Vercel backend hosts the EBAAD Shield runtime, which decrypts and runs protected content in memory when authorised by your licence.

1. Install the Vercel CLI (or connect via GitHub):
   ```bash
   npm install -g vercel
   ```
2. Navigate to your recipient backend directory containing:
   * `app.ebaad`
   * `server.mjs`
   * `config.json`
   * `public.pem`
   * `package.json`
3. Run:
   ```bash
   vercel
   ```
4. Follow the command-line prompts:
   * Set up and deploy? **Yes**
   * Link to existing project? **No**
   * Project name: `blueberri-backend`
   * Deploy to production: `vercel --prod`
5. Note your assigned Vercel URL (e.g. `https://blueberri-backend.vercel.app`).

---

## Step 8: Connect the Google Storage Frontend to the Vercel Backend

1. In your frontend client configuration file, set the backend API endpoint to your Vercel deployment:
   ```javascript
   window.__EBAAD_BACKEND_URL__ = "https://your-project.vercel.app";
   ```
2. All dynamic API calls, protected page requests, and licence-gated routes will route from the browser to your Vercel serverless function.

---

## Step 9: Configure CORS for the Bucket Origin

Because your frontend runs on Google Cloud Storage (`storage.googleapis.com` or your custom domain) and communicates with Vercel (`*.vercel.app`), Cross-Origin Resource Sharing (CORS) must be enabled:

1. Create a `cors.json` file:
   ```json
   [
     {
       "origin": ["*"],
       "method": ["GET", "HEAD", "OPTIONS"],
       "responseHeader": ["Content-Type", "Authorization", "x-licence-key"],
       "maxAgeSeconds": 3600
     }
   ]
   ```
2. Apply it to your Google Cloud Storage bucket:
   ```bash
   gcloud storage buckets update gs://YOUR_BUCKET_NAME --cors-file=cors.json
   ```
3. In your Vercel backend configuration (`vercel.json` or HTTP headers), allow requests originating from your bucket domain:
   ```json
   {
     "headers": [
       {
         "source": "/api/(.*)",
         "headers": [
           { "key": "Access-Control-Allow-Origin", "value": "*" },
           { "key": "Access-Control-Allow-Methods", "value": "GET,POST,OPTIONS" },
           { "key": "Access-Control-Allow-Headers", "value": "Content-Type,Authorization" }
         ]
       }
     ]
   }
   ```

---

## Step 10: Configure the Recipient Licence Key

Ensure your `config.json` on the Vercel backend contains your active licence key:

```json
{
  "licenceKey": "EBAAD-DIST-A8F4C2E9",
  "wispUrl": "wss://studynestlab.org/wisp/",
  "licenceApiUrl": "https://ebaad-licence-service.vercel.app"
}
```

* **Licence Key:** Identifies your installation.
* **Licence API URL:** Production authority validating licence status.
* **Wisp URL:** Direct WebSocket proxy transport.

---

## Step 11: Testing & Verification Checklist

Complete these four verification tests:

1. **Website Navigation:** Open your website URL and click through the navigation links to verify pages render properly.
2. **Credits & Attribution:** Open **Settings** in the website UI and confirm the **Credits** section displays correctly.
3. **Licence Validation:** In the Vercel logs (`vercel logs`), check that the backend successfully calls `/api/activate` and achieves `ACTIVE` status.
4. **Wisp Connectivity:** Open browser Developer Tools (**F12 > Network tab > Filter: WS**). Refresh and verify that an active WebSocket handshake (`101 Switching Protocols`) connects to `wss://studynestlab.org/wisp/`.

---

## Step 12: Custom Domain & HTTPS Setup (Costs & Comparison)

### Google Cloud Storage Custom Domain
* **Limitation:** Google Cloud Storage does **not** natively support HTTPS on custom domains (e.g. `http://www.yourdomain.com` works via CNAME to `c.storage.googleapis.com`, but `https://` will show SSL errors).
* **Cost:** To enable HTTPS on Google Cloud Storage with a custom domain, Google Cloud requires an **External HTTPS Cloud Load Balancer**, which costs **~$18 - $25/month** in GCP forwarding rule fees.
* **Free Alternative (Cloudflare):** Point your domain DNS to Cloudflare and create a CNAME pointing to `c.storage.googleapis.com` with Cloudflare's **Orange Cloud (Proxy)** enabled. Cloudflare provides free SSL terminating at their edge at **$0/month**.

### All-in-One Alternative (Pure Vercel Deployment)
* If you deploy both the frontend and backend directly to **Vercel**:
  * **Cost:** **$0/month** (included in free Hobby tier).
  * **SSL:** Automatic, instant zero-configuration HTTPS.
  * **CORS:** Zero cross-origin issues (frontend and backend share the same domain).
  * **Service Worker Proxy Compatibility:** Full native support for Ultraviolet / Bare-Mux / Wisp service workers without cross-origin iframe restrictions.

---

## Security & Architecture Summary

* **Proprietary Source Protection:** Core code remains encrypted inside `app.ebaad` and is only decrypted in server memory on Vercel during an active, valid licence lease.
* **Kill Switch:** If a licence is revoked or disabled on the central licensing server, the Vercel backend ceases serving protected assets, disabling the installation.
* **Direct Wisp Traffic:** All client proxy traffic flows over secure WebSockets directly from the user's browser to `wss://studynestlab.org/wisp/`, without passing through or burdening your Vercel or GCP bandwidth.
