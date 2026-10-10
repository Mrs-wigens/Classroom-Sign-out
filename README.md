# Student Exit Tracker

A touch-friendly classroom kiosk for recording when students leave and return.

## Features

- Students type their own names.
- Washroom, water, and locker share a one-student capacity.
- Library allows five students at once.
- Office and Other are unrestricted.
- Shared and library waiting queues.
- Clickable **Who can go next** buttons.
- Clickable return buttons for students currently out.
- PIN-protected teacher dashboard. Default PIN: `1987`.
- Searchable trip history and CSV export.
- Local browser persistence when opened from GitHub Pages.
- Optional shared activity storage when hosted by a classroom computer on a local network.

## Data and privacy

The GitHub Pages version stores data in the current browser on the current device; it does not synchronize between devices. The local-network mode below stores shared records in a JSON file on the host computer. It is not a school-approved records system by itself.

The local-network server uses HTTP, so network traffic (including the teacher PIN) is not encrypted. Anyone able to reach the server can view current activity and submit tracker actions; the teacher PIN only restricts the full history dashboard. Data on the host is not encrypted by this app. Do not use it for student records unless school IT approves the setup and confirms the classroom network, host, and storage are appropriately protected. Do not expose the server to the public internet or a guest Wi-Fi network.

## Pair a teacher monitor and student kiosk with QR codes

The GitHub Pages app can pair one teacher monitor with one student tablet directly in the browsers. No shared cloud database or classroom server is used: the monitor's browser keeps the complete trip history, and the tablet exchanges current activity over an encrypted WebRTC data channel. Both pages must stay open and connected; closing or refreshing the monitor ends the session. Re-pair the tablet to reconnect. The tablet cannot view past trips.

1. Deploy the app to GitHub Pages and open the live site on the teacher's computer.
2. Select **Teacher**, enter the teacher PIN, and choose **Pair student kiosk**.
3. On the tablet, open the same GitHub Pages site, choose **Connect to teacher monitor**, and scan the QR code on the teacher's screen.
4. The tablet displays a response QR code. On the teacher computer, choose **Scan the tablet's response** and scan that code with the computer camera. Keep both pages open.
5. The teacher dashboard shows when the kiosk is connected. Activity entered on the tablet appears in the dashboard.

Camera scanning needs a secure browser context, camera permission, and a browser that supports camera capture. Pairing uses only direct local-network candidates and no relay service; both devices therefore need to be on the same Wi-Fi, and school network rules must permit direct device-to-device connections. The QR codes contain temporary network connection details. Use them only in the classroom and do not post or share them. The teacher's browser storage is still subject to local device/browser policies; export and back up records only through school-approved methods.

## Run locally

```bash
npm install
npm run dev
```

Open the local URL shown by Vite.

## Share activity over a classroom network

This alternative stores shared records in a JSON file on a classroom computer. The host computer must stay awake and running the server. This is separate from QR browser pairing and requires the tablet to visit the server's local network address.

1. Get school IT approval for storing this student information on the host computer and for using the local network.
2. Install Node.js 20 or newer on the Windows computer that will host the tracker.
3. Open PowerShell in this project folder and install the packages once:

   ```powershell
   npm install
   ```

4. Start the server with a new 8-to-12-digit teacher PIN:

   ```powershell
   $env:TRACKER_TEACHER_PIN = 'REPLACE_WITH_YOUR_OWN_8_TO_12_DIGIT_PIN'
   npm run lan
   ```

   Replace the placeholder with a unique PIN before running the commands. Keep that PowerShell window open. The server prints its local network address, such as `http://192.168.1.25:4173/`; use the address for the host's classroom Wi-Fi adapter. The first time it runs, allow Node.js through Windows Firewall on **Private networks only**, if prompted. Ask IT to reserve the host's network address or make a new QR code if it changes.
5. Connect the tablet and monitoring computer to the same trusted classroom Wi-Fi (not a guest network). Create a QR code containing the printed `http://...:4173/` address using a school-approved QR tool, then scan it with the tablet. The monitoring computer can open that same address.
6. To stop the server, close its PowerShell window. The shared data is saved in `data/tracker-data.json` on the host. Back up that file using a school-approved location; the `data/` folder is excluded from Git so records are not uploaded with the source code.

If a tablet cannot connect, check that the server is still running, both devices are on the same Wi-Fi, the host address is current, and Windows Firewall permits Node.js on the Private network. School Wi-Fi may isolate devices from one another; school IT would need to allow the tablet to reach the host.

## Build

```bash
npm run build
npm run preview
```

## Put it on GitHub

1. Create a new empty GitHub repository.
2. Upload all files and folders from this project.
3. Commit them to the `main` branch.
4. In the repository, open **Settings > Pages**.
5. Under **Build and deployment**, choose **GitHub Actions**.
6. Open the **Actions** tab and watch the deployment workflow.
7. When deployment completes, the Pages URL appears in the deployment details.

## Change the GitHub Pages teacher PIN

For GitHub Pages/local-only mode, change this value in `src/App.jsx`:

```js
const TEACHER_PIN = '1987';
```

This PIN is a classroom convenience barrier, not strong security. Anyone with access to the public source repository can read it.

For the local-network server, set `TRACKER_TEACHER_PIN` in the PowerShell process before starting `npm run lan`. The server requires a new 8-to-12-digit PIN and does not use the value in `src/App.jsx`.

## Recommended next stage

For an approved, encrypted, and managed solution, have school IT connect the tracker to a school-approved backend such as SharePoint/Microsoft Lists through an authenticated API layer.
