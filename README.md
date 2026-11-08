# Mosaic AI

A responsive multi-model AI chat website. The browser talks only to the server; the Mesh API key stays private on the server. Sponsored content is displayed in a desktop right-hand rail.

## Local preview with a Mesh API key

1. Double-click `local-preview.cmd` in this folder. The first run opens `.env.local` in Notepad.
2. Add your Mesh key to the file in this format, replacing the sample value:

```text
MESH_API_KEY=your_real_mesh_api_key
```

3. Save and close Notepad. If the server window says the key is missing, run `local-preview.cmd` again.
4. Open or refresh http://localhost:8765. Models are loaded from your Mesh account, and chat requests use the selected model.
5. To stop the preview server, focus its PowerShell window and press Ctrl+C.

Keep `.env.local` private. It is ignored by Git; do not commit or share your key. Do not type the key into the website's chat box or send it in a message.

## Deploy on Render

The included `render.yaml` is a Render Blueprint for the Node web service.

1. Push this project to a GitHub repository.
2. Create a Render account, choose **New + > Blueprint**, and connect the repository containing `render.yaml`.
3. Confirm the service creation. In the new `mosaic-ai` service's **Environment** settings, set `MESH_API_KEY` to your private Mesh API key. Never commit the key or put it in `app.js`.
4. Deploy. Render supplies an `onrender.com` URL; open it and check that the model list loads and a chat works.
5. In the Render service, open **Settings > Custom Domains** and add both `ritvik.studio` and `www.ritvik.studio`. Use the exact DNS targets/records Render shows for your service.
6. In Name.com, open **My Domains > ritvik.studio > Manage DNS** and add the records provided by Render. Typically Render uses an A record for the root (`@`) to `216.24.57.1` and a CNAME for `www` to your exact Render hostname. Prefer the targets shown by your Render dashboard if they differ. Remove conflicting existing A/CNAME records and any AAAA records for these web hosts. Do not delete MX/TXT records used by email or verification.
7. Allow DNS time to propagate, then return to Render and verify the domains. Render provisions HTTPS automatically.

If Name.com is not authoritative for your DNS (the domain uses custom nameservers), make these DNS changes with the provider managing those nameservers instead.

## Costs and advertising

The site does not ask visitors for their own API keys. Requests use the site owner's Mesh account, so usage may cost money. The model picker marks models Mesh identifies as free; availability, limits, and pricing depend on Mesh and your account. Add spend limits/rate limiting before making the site public. The corner rail is a labeled sponsored-placement preview, not a live ad-network integration.
