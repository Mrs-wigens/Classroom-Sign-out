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
- Browser persistence using `localStorage`.

## Important data limitation

This version stores data in the current browser on the current device. GitHub Pages hosts the app interface, but it does not synchronize records between devices. Before using this as an official student record, connect it to an approved school data source and review school privacy requirements.

## Run locally

```bash
npm install
npm run dev
```

Open the local URL shown by Vite.

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

## Change the teacher PIN

In `src/App.jsx`, change:

```js
const TEACHER_PIN = '1987';
```

This PIN is a classroom convenience barrier, not strong security. Anyone with access to the public source repository can read it.

## Recommended next stage

Replace `localStorage` with an approved shared backend, such as Dataverse, SharePoint/Microsoft Lists through an authenticated API layer, or another school-approved database.
