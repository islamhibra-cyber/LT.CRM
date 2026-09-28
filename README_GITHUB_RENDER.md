# Deploying CACAO WhatsApp CRM to Render via GitHub

This package is pre-configured for seamless, one-click deployment on **Render.com** (Free or Paid Web Service) with full Node.js / Express backend, React 19 frontend, persistent database, and public HTTPS webhook support for Meta WhatsApp Business Cloud API.

---

## 🚀 Quick Setup Guide (Step-by-Step)

### Step 1: Push this Project to GitHub

1. Extract this ZIP archive to a folder on your computer.
2. Open a terminal or Command Prompt in the extracted folder.
3. Run the following Git commands:
   ```bash
   git init
   git add .
   git commit -m "Initial commit for Render deployment"
   ```
4. Create a new repository on **[GitHub.com](https://github.com/new)** (e.g., `cacao-whatsapp-crm`).
5. Link your local project to your new GitHub repository:
   ```bash
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/cacao-whatsapp-crm.git
   git push -u origin main
   ```

---

### Step 2: Deploy on Render

1. Log in to your **[Render Dashboard](https://dashboard.render.com/)**.
2. Click **New +** -> **Web Service**.
3. Select **"Build and deploy from a Git repository"** and choose your `cacao-whatsapp-crm` repository.
4. Render will automatically detect settings, or configure:
   - **Name:** `cacao-whatsapp-crm` (or any name you like)
   - **Environment:** `Node`
   - **Region:** Choose closest to your users (e.g., Frankfurt or Oregon)
   - **Branch:** `main`
   - **Build Command:** `npm install && npm run build`
   - **Start Command:** `npm start`
   - **Plan:** `Free` (or Starter for 24/7 background queue)
5. Under **Environment Variables**, add:
   - `NODE_ENV` = `production`
   - `HOST` = `0.0.0.0`
6. Click **Deploy Web Service**!

---

### Step 3: Accessing Your CRM & Linking Meta WhatsApp Webhook

Once Render finishes building (usually 1-2 minutes):
1. Your public URL will be ready: `https://cacao-whatsapp-crm.onrender.com`
2. Default login credentials:
   - **Username:** `admin`
   - **Password:** `admin123`
3. **Connecting WhatsApp Webhook on Meta Developer Portal:**
   - In Meta App Dashboard -> WhatsApp -> Configuration:
   - **Callback URL:** `https://your-service-name.onrender.com/api/webhook/whatsapp`
   - **Verify Token:** `waba_crm_secure_verify_2026` (or the token configured in your CRM Settings)
   - Webhook Fields: Select `messages`
