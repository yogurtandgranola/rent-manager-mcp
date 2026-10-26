# Team setup: Rent Manager in Claude for your whole team

This puts the Rent Manager connector online so everyone on your team can use it in Claude on the web, desktop and phone.

- Team members sign in with their company Google account. Anyone outside your company is turned away.
- Everyone can look things up: rent rolls, delinquency, ledgers, notes, work orders.
- Only the people listed as **editors** can add tenant notes or create work orders.

It takes about 30 minutes, and you don't need to write any code. You'll use three websites: **Google Cloud** (sign-in), **Render** (hosting, about $7/month) and **Claude** (adding the connector).

Have these ready:

- Your Rent Manager **corporate ID**, **API username** and **API password** (from Rent Manager support if you don't have them)
- A **Google Workspace** account at your company
- Owner access to your **Claude Team** account
- Access to the GitHub repo `rent-manager-mcp`

---

## Part 1: Create the Google sign-in (10 minutes)

This tells Google that your connector is allowed to ask people to sign in.

1. Go to <https://console.cloud.google.com> and sign in with your **company** Google account.
2. At the top left, click the project picker, then **New project**. Name it `Rent Manager Connector` and click **Create**. Make sure the new project is selected afterwards.
3. In the search bar at the top, type **Google Auth Platform** and open it. Click **Get started**.
   - App name: `Rent Manager Connector`
   - User support email: your email
   - Audience: choose **Internal**. This means only people in your Google Workspace can sign in.
   - Contact email: your email
   - Agree and click **Create**.
4. In the left menu, click **Clients**, then **Create client**.
   - Application type: **Web application**
   - Name: `Claude connector`
   - Leave **Authorized redirect URIs** empty for now. You'll come back in Part 3.
   - Click **Create**.
5. A box shows a **Client ID** and **Client secret**. Copy both somewhere safe for the next step.

## Part 2: Put the server online with Render (10 minutes)

1. Make sure the latest version of this repo is on the `main` branch (merge the open pull request on GitHub).
2. Go to <https://render.com> and sign up with your GitHub account.
3. Click **New**, then **Blueprint**. Connect GitHub if asked, and pick the `rent-manager-mcp` repo.
4. Render reads the setup file and asks for these values:

   | Setting | What to enter |
   |---|---|
   | `RM_CORP_ID` | Your Rent Manager corporate ID (the `yourcompany` in `yourcompany.api.rentmanager.com`) |
   | `RM_USERNAME` | Rent Manager API username |
   | `RM_PASSWORD` | Rent Manager API password |
   | `GOOGLE_CLIENT_ID` | From Part 1, step 5 |
   | `GOOGLE_CLIENT_SECRET` | From Part 1, step 5 |
   | `ALLOWED_DOMAINS` | Your company email domain, e.g. `cornellcommunities.com` |
   | `EDITOR_EMAILS` | Your own company email. Add others separated by commas if more people should be able to write |

5. Click **Apply**. Render builds and starts the server, which takes a few minutes.
6. When it says **Live**, open the service. Near the top, under the name, is its address, something like `https://rent-manager-mcp-ab12.onrender.com`. Copy it exactly.

   > **Use your own address, not the example.** Render addresses are shared by all Render customers, so yours usually ends in a few extra letters. `rent-manager-mcp.onrender.com` without them belongs to someone else.
7. Check it works: open that address with `/health` on the end. You should see `{"ok":true,...}` along with the exact connector URL to give Claude. If you see anything else, such as `{"error":"not found"}`, you're looking at a different server.

> If Rent Manager only accepts connections from approved IP addresses, open the service in Render, click **Connect**, then **Outbound**, and send those IP addresses to Rent Manager support.

## Part 3: Finish the Google sign-in (2 minutes)

1. Go back to <https://console.cloud.google.com>, then **Google Auth Platform**, then **Clients**, and click **Claude connector**.
2. Under **Authorized redirect URIs**, click **Add URI** and paste your Render address followed by `/oauth/google/callback`, for example:
   `https://rent-manager-mcp-ab12.onrender.com/oauth/google/callback`
3. Click **Save**. Google says changes can take a few minutes.

## Part 4: Add it to Claude (5 minutes)

**Owner, once for the whole team:**

1. In Claude on the web, open **Settings** (or **Admin settings**), then **Connectors**.
2. Click **Add**, then **Custom**, then **Web**.
3. Name: `Rent Manager`. URL: your Render address followed by `/mcp`, for example `https://rent-manager-mcp-ab12.onrender.com/mcp`. The `/health` page from Part 2 shows the exact URL
4. Click **Add**.

**Each team member, including you:**

1. In Claude on the web, open **Settings**, then **Connectors**, find **Rent Manager** and click **Connect**.
2. Sign in with your company Google account.
3. In a chat, ask: "Test the Rent Manager connection." It should show your name and either "read/write" (editors) or "read-only".

After connecting on the web, the connector is also available in the Claude desktop and mobile apps on the same account.

---

## Managing access later

All changes happen in Render: open the service, click **Environment**, edit, then **Save changes**. Render restarts the server in about a minute.

| To do this | Change this |
|---|---|
| Let someone write notes and work orders | Add their email to `EDITOR_EMAILS` (comma separated) |
| Let in someone outside your domain (e.g. a contractor's Gmail) | Add a setting `ALLOWED_EMAILS` with their address |
| Cut someone off right away | Remove their email from `ALLOWED_EMAILS` / `EDITOR_EMAILS`. For someone in your domain, suspend their Google account, then change `AUTH_SECRET` to sign everyone out |
| Turn off all writing for everyone | Add `RM_READ_ONLY` = `true` |
| Sign everyone out | Change `AUTH_SECRET` to a new long random value |

**Who did what:** Render's **Logs** tab shows each sign-in and every tool someone used, with their email.

## Troubleshooting

| What you see | Likely cause |
|---|---|
| Google says "invalid_client" or "The OAuth client was not found" | `GOOGLE_CLIENT_ID` in Render is garbled (often extra line breaks from copying). Copy it again with Google's copy button and paste it into an emptied box |
| Google says "redirect_uri_mismatch" | Part 3's address doesn't exactly match your Render address plus `/oauth/google/callback` |
| "...is not allowed to use this connector" | The person signed in with a personal Google account, or `ALLOWED_DOMAINS` is misspelled |
| Google says "access blocked: app is restricted to users within its organization" | Same: they used an account outside your Workspace |
| Claude says the connector failed or timed out | Open the Render address + `/health`. If it doesn't load, check Render's **Logs** tab; a missing setting is named there |
| Tools return "Authentication failed" | Rent Manager username, password, corporate ID or location ID is wrong |
| Claude says "Couldn't register with ... sign-in service" | Open Render's **Logs** tab and try **Connect** again. Look for lines starting with `[http] POST /register`: the status and message after the arrow say what went wrong |
| Claude shows "Redirect URI not allowed" when connecting | Anthropic changed its callback address. Add a setting `EXTRA_REDIRECT_HOSTS` with the host named in the message |
| Editors don't see the note/work order tools | Their email isn't in `EDITOR_EMAILS` exactly, or they need to disconnect and reconnect in Claude |
