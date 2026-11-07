import type { ServiceKind, TechKind } from './types';

/**
 * Fixed explanations, reviewed and checked into the repo. This is the part of
 * the tool a model would normally improvise on every run, and keeping it as
 * data is why it can run with no model at all. Keep each `plain` to what the
 * thing is for someone who has never heard of it. No marketing words.
 */
export interface CatalogEntry {
  id: string;
  name: string;
  kind: TechKind;
  plain: string;
  analogy?: string;
  /** npm or PyPI names. A trailing * matches a prefix. */
  match: string[];
  /** The running app talks to this over the network. */
  service?: boolean;
  /** Env var prefixes that belong to this service. */
  env?: RegExp;
  host?: RegExp;
}

const E = (
  id: string, name: string, kind: TechKind, match: string[], plain: string,
  extra: Partial<CatalogEntry> = {},
): CatalogEntry => ({ id, name, kind, match, plain, ...extra });

const S = (
  id: string, name: string, kind: ServiceKind, match: string[], plain: string,
  extra: Partial<CatalogEntry> = {},
): CatalogEntry => ({ id, name, kind, match, plain, service: true, ...extra });

export const CATALOG: CatalogEntry[] = [
  // Frameworks
  E('next', 'Next.js', 'framework', ['next'], 'A framework built on React. It decides which code runs in the browser and which runs on your server, and it turns your folders into website addresses.', { analogy: 'The building your app lives in: it already has the wiring, so you only add the rooms.' }),
  E('react', 'React', 'ui', ['react', 'react-dom'], 'A library for building screens out of small reusable pieces called components. When data changes, React redraws only the pieces that need it.', { analogy: 'Lego for interfaces.' }),
  E('react-native', 'React Native', 'framework', ['react-native'], 'Lets you write React and get a real phone app instead of a website.'),
  E('expo', 'Expo', 'framework', ['expo', 'expo-*'], 'A toolkit on top of React Native that handles building and shipping phone apps so you do not touch Xcode or Android Studio much.'),
  E('vue', 'Vue', 'ui', ['vue'], 'A library for building screens out of components. It does the same job as React with a different style of writing.'),
  E('nuxt', 'Nuxt', 'framework', ['nuxt'], 'A framework built on Vue, in the same way Next.js is built on React.'),
  E('svelte', 'Svelte', 'ui', ['svelte'], 'A way of building screens where the work happens when you build the app, so less code runs in the browser.'),
  E('sveltekit', 'SvelteKit', 'framework', ['@sveltejs/kit'], 'A framework built on Svelte. It handles pages, server code and addresses.'),
  E('astro', 'Astro', 'framework', ['astro'], 'A framework for mostly static sites. It sends plain HTML by default and adds JavaScript only where you ask for it.'),
  E('remix', 'Remix', 'framework', ['@remix-run/*', 'react-router-dom', 'react-router'], 'Handles moving between pages in a React app without a full page reload, and can also load data for each page.'),
  E('vite', 'Vite', 'build', ['vite'], 'The tool that runs your app while you develop and bundles it for release. It is not part of the running app.'),
  E('electron', 'Electron', 'framework', ['electron'], 'Wraps a web app in a desktop window. Your app ships with its own copy of Chrome and Node.js.'),
  E('tauri', 'Tauri', 'framework', ['@tauri-apps/*'], 'Wraps a web app in a desktop window using the system browser and a small Rust program, so it is much lighter than Electron.'),

  // Servers
  E('express', 'Express', 'framework', ['express'], 'A small Node.js server. You tell it "when a request arrives at this address, run this function".', { analogy: 'A receptionist who sends each visitor to the right desk.' }),
  E('hono', 'Hono', 'framework', ['hono', '@hono/*'], 'A very small web server that does the job of Express and also runs on edge platforms like Cloudflare.'),
  E('fastify', 'Fastify', 'framework', ['fastify', '@fastify/*'], 'A Node.js server like Express, designed to be faster and to check request data.'),
  E('nestjs', 'NestJS', 'framework', ['@nestjs/*'], 'A structured Node.js server framework. It organises code into modules and controllers, in a style borrowed from Java.'),
  E('koa', 'Koa', 'framework', ['koa', 'koa-router', '@koa/router'], 'A small Node.js server from the people who made Express.'),
  E('fastapi', 'FastAPI', 'framework', ['fastapi'], 'A Python web server. It reads your type hints to check incoming data and to write API docs for you.'),
  E('flask', 'Flask', 'framework', ['flask', 'Flask'], 'A small Python web server. You attach functions to addresses.'),
  E('django', 'Django', 'framework', ['django', 'Django'], 'A large Python web framework that includes an admin panel, login system and database tools.'),
  E('streamlit', 'Streamlit', 'framework', ['streamlit'], 'Turns a Python script into a small web app. The whole script re-runs whenever someone interacts with it.'),
  E('gradio', 'Gradio', 'framework', ['gradio'], 'Builds a quick web interface around a Python function, usually to demo a model.'),
  E('uvicorn', 'Uvicorn', 'tooling', ['uvicorn'], 'The program that actually runs a Python web server and listens for traffic.'),
  E('trpc', 'tRPC', 'library', ['@trpc/*'], 'Lets the browser call server functions directly with full type checking, instead of writing fetch calls by hand.'),
  E('graphql', 'GraphQL', 'library', ['graphql', '@apollo/*', 'urql', 'graphql-request'], 'A way for the browser to ask for exactly the data it wants through one address, instead of many separate routes.'),
  E('socketio', 'Socket.IO', 'library', ['socket.io', 'socket.io-client'], 'Keeps a live two-way connection open between browser and server, for chat or live updates.'),
  E('ws', 'ws', 'library', ['ws'], 'A WebSocket library: a connection that stays open so the server can push updates.'),

  // Languages
  E('typescript', 'TypeScript', 'language', ['typescript'], 'JavaScript with labels saying what kind of data each thing is. Mistakes show up before the code runs. Browsers never see it: it is converted to JavaScript first.', { analogy: 'A spellchecker for data.' }),

  // Databases and backends
  S('supabase', 'Supabase', 'database', ['@supabase/*', 'supabase'], 'A hosted Postgres database with login, file storage and an API on top. Your browser can talk to it directly, so its access rules are the only thing standing between strangers and your data.', { env: /SUPABASE/, host: /supabase\.(co|in)/ }),
  S('firebase', 'Firebase', 'database', ['firebase', 'firebase-admin', 'firebase/*'], 'Google\'s app backend: a database, login and file storage that your app talks to directly, protected by security rules you write.', { env: /FIREBASE/, host: /firebase|firestore\.googleapis/ }),
  S('prisma', 'Prisma', 'database', ['@prisma/client', 'prisma'], 'A translator between your code and your database. You describe tables in one schema file and call functions instead of writing SQL.', { env: /^DATABASE_URL|^DIRECT_URL/ }),
  S('drizzle', 'Drizzle', 'database', ['drizzle-orm'], 'A way to write database queries in TypeScript. Your tables are defined in code.', { env: /^DATABASE_URL/ }),
  S('mongoose', 'MongoDB (Mongoose)', 'database', ['mongoose'], 'Mongoose lets your code store and fetch documents in MongoDB, a database that keeps records as flexible JSON-like objects.', { env: /MONGO/ }),
  S('mongodb', 'MongoDB', 'database', ['mongodb'], 'A database that stores records as flexible JSON-like documents instead of rows in tables.', { env: /MONGO/ }),
  S('postgres', 'Postgres', 'database', ['pg', 'postgres', '@neondatabase/serverless', '@vercel/postgres', 'psycopg2', 'psycopg2-binary', 'psycopg', 'asyncpg'], 'A relational database: your data lives in tables with rows and columns, and you ask for it in SQL.', { env: /POSTGRES|^PG|^DATABASE_URL|^NEON/ }),
  S('mysql', 'MySQL', 'database', ['mysql', 'mysql2', 'pymysql', 'mysqlclient'], 'A relational database: data in tables, queried with SQL.', { env: /MYSQL/ }),
  S('sqlite', 'SQLite', 'database', ['better-sqlite3', 'sqlite3', 'sqlite', 'node:sqlite', 'bun:sqlite', 'libsql', '@libsql/client'], 'A database that is a single file on disk. Simple and fast, but it lives on one machine, and many hosts wipe that disk when you redeploy.', { env: /TURSO|LIBSQL/ }),
  S('redis', 'Redis', 'database', ['redis', 'ioredis', '@upstash/redis'], 'A very fast store that keeps data in memory. Usually used for caches, rate limits and short-lived data.', { env: /REDIS|UPSTASH/ }),
  S('sqlalchemy', 'SQLAlchemy', 'database', ['sqlalchemy', 'SQLAlchemy', 'sqlmodel'], 'The standard Python way of talking to a SQL database through objects instead of raw SQL.', { env: /^DATABASE_URL/ }),
  S('convex', 'Convex', 'database', ['convex'], 'A hosted backend where database queries are TypeScript functions and the screen updates live when data changes.', { env: /CONVEX/ }),
  S('pinecone', 'Pinecone', 'database', ['@pinecone-database/pinecone', 'pinecone-client', 'pinecone'], 'A database for AI embeddings. It finds things by meaning rather than exact match.', { env: /PINECONE/ }),
  S('tigerdata', 'Tiger Data', 'database', ['@timescale/*'], 'Hosted Postgres built for time-series data.', { env: /TIGER|TIMESCALE/ }),
  S('neo4j', 'Neo4j', 'database', ['neo4j-driver', 'neo4j'], 'A database that stores things and the relationships between them as a graph.', { env: /NEO4J/ }),

  // Auth
  S('clerk', 'Clerk', 'auth', ['@clerk/*'], 'A hosted login service. It handles sign-up, passwords and sessions so your code only asks "who is this?".', { env: /CLERK/, host: /clerk\./ }),
  S('authjs', 'Auth.js (NextAuth)', 'auth', ['next-auth', '@auth/*'], 'A login library that runs inside your own app and handles sessions and sign-in with Google, GitHub and others.', { env: /NEXTAUTH|^AUTH_/ }),
  S('auth0', 'Auth0', 'auth', ['@auth0/*', 'auth0'], 'A hosted login service for sign-up, sign-in and sessions.', { env: /AUTH0/, host: /auth0\.com/ }),
  S('betterauth', 'Better Auth', 'auth', ['better-auth'], 'A login library that runs inside your own app and stores users in your own database.', { env: /BETTER_AUTH/ }),
  E('jwt', 'JSON Web Tokens', 'library', ['jsonwebtoken', 'jose', 'pyjwt', 'PyJWT', 'python-jose'], 'A signed note that proves who someone is. The server can check the signature without looking anything up.', { analogy: 'A wristband at an event.' }),
  E('bcrypt', 'bcrypt', 'library', ['bcrypt', 'bcryptjs', 'argon2', 'passlib'], 'Scrambles passwords in a way that cannot be reversed, so a leaked database does not leak passwords.'),

  // Payments
  S('stripe', 'Stripe', 'payments', ['stripe', '@stripe/*'], 'Takes card payments for you. Your app never sees card numbers. Stripe tells your server what happened through webhooks.', { env: /STRIPE/, host: /stripe\.com/ }),
  S('polar', 'Polar', 'payments', ['@polar-sh/*'], 'A payments service for selling software and subscriptions.', { env: /POLAR/, host: /polar\.sh/ }),
  S('lemonsqueezy', 'Lemon Squeezy', 'payments', ['@lemonsqueezy/*'], 'A payments service that also handles sales tax for you.', { env: /LEMON/, host: /lemonsqueezy/ }),
  S('paypal', 'PayPal', 'payments', ['@paypal/*'], 'Takes payments through PayPal accounts.', { env: /PAYPAL/, host: /paypal\.com/ }),

  // AI
  S('openai', 'OpenAI', 'ai', ['openai', '@ai-sdk/openai', 'langchain-openai'], 'Sends text to a model like GPT and returns what it wrote. You pay per word, so each call costs money, and the text you send leaves your server.', { env: /OPENAI/, host: /openai\.com/ }),
  S('anthropic', 'Anthropic', 'ai', ['@anthropic-ai/*', 'anthropic', '@ai-sdk/anthropic'], 'Sends text to a Claude model and returns its reply. You pay per word, and the text you send leaves your server.', { env: /ANTHROPIC|CLAUDE/, host: /anthropic\.com/ }),
  S('gemini', 'Google Gemini', 'ai', ['@google/generative-ai', '@google/genai', 'google-generativeai', 'google-genai', '@ai-sdk/google'], 'Sends text or images to a Gemini model and returns its reply. Usage is billed, and the content you send leaves your server.', { env: /GEMINI|GOOGLE_API_KEY|GOOGLE_GENERATIVE/, host: /generativelanguage\.googleapis/ }),
  S('groq', 'Groq', 'ai', ['groq-sdk', 'groq', '@ai-sdk/groq'], 'Runs open AI models very fast on hosted hardware. Your text is sent to their servers.', { env: /GROQ/, host: /groq\.com/ }),
  S('mistral', 'Mistral', 'ai', ['@mistralai/*', 'mistralai', '@ai-sdk/mistral'], 'Hosted AI models from a French company. Your text is sent to their servers.', { env: /MISTRAL/, host: /mistral\.ai/ }),
  S('openrouter', 'OpenRouter', 'ai', ['@openrouter/*'], 'One account that reaches many AI models from different companies.', { env: /OPENROUTER/, host: /openrouter\.ai/ }),
  S('ollama', 'Ollama (local AI)', 'ai', ['ollama'], 'Runs AI models on your own computer. No per-word bill, and nothing leaves the machine it runs on, but that machine must be on and have the model.', { env: /OLLAMA/, host: /localhost:11434|127\.0\.0\.1:11434/ }),
  S('vercel-ai', 'Vercel AI SDK', 'ai', ['ai', '@ai-sdk/*', '@vercel/ai'], 'A toolkit that gives one way to call many AI models and stream the words back as they are written.'),
  S('langchain', 'LangChain', 'ai', ['langchain', '@langchain/*', 'langchain-*'], 'A toolkit for chaining AI model calls together with tools and data.'),
  S('mastra', 'Mastra', 'ai', ['@mastra/*', 'mastra'], 'A TypeScript framework for building AI agents and workflows.'),
  S('huggingface', 'Hugging Face', 'ai', ['@huggingface/*', 'huggingface-hub', 'huggingface_hub', 'transformers', 'sentence-transformers'], 'A hub for open AI models. This code either downloads a model or calls one hosted there.', { env: /^HF_|HUGGING/, host: /huggingface\.co/ }),
  S('replicate', 'Replicate', 'ai', ['replicate'], 'Runs AI models in the cloud and bills you per run.', { env: /REPLICATE/, host: /replicate\.com/ }),
  S('elevenlabs', 'ElevenLabs', 'ai', ['elevenlabs', '@elevenlabs/*'], 'Turns text into realistic speech. Billed per character.', { env: /ELEVEN/, host: /elevenlabs\.io/ }),
  S('fal', 'fal', 'ai', ['@fal-ai/*', 'fal-client'], 'Runs image and video AI models in the cloud, billed per run.', { env: /^FAL_/, host: /fal\.(ai|run)/ }),

  // Email and messaging
  S('resend', 'Resend', 'email', ['resend'], 'Sends email from your app.', { env: /RESEND/, host: /resend\.com/ }),
  S('sendgrid', 'SendGrid', 'email', ['@sendgrid/*', 'sendgrid'], 'Sends email from your app.', { env: /SENDGRID/, host: /sendgrid/ }),
  S('nodemailer', 'Nodemailer', 'email', ['nodemailer'], 'Sends email through a mail server you configure.', { env: /SMTP/ }),
  S('postmark', 'Postmark', 'email', ['postmark'], 'Sends email from your app.', { env: /POSTMARK/, host: /postmarkapp/ }),
  S('twilio', 'Twilio', 'messaging', ['twilio'], 'Sends texts and makes phone calls from code. Each one costs money.', { env: /TWILIO/, host: /twilio\.com/ }),
  S('telegram', 'Telegram', 'messaging', ['node-telegram-bot-api', 'telegraf', 'grammy', 'python-telegram-bot'], 'Lets your code send and receive Telegram messages as a bot.', { env: /TELEGRAM/, host: /api\.telegram\.org/ }),
  S('discord', 'Discord', 'messaging', ['discord.js', 'discord.py'], 'Lets your code act as a Discord bot.', { env: /DISCORD/, host: /discord\.com/ }),
  S('slack', 'Slack', 'messaging', ['@slack/*', 'slack-sdk'], 'Lets your code post to and read from Slack.', { env: /SLACK/, host: /slack\.com/ }),
  S('webpush', 'Web Push', 'messaging', ['web-push'], 'Sends notifications to people\'s browsers or phones even when your site is closed.', { env: /VAPID/ }),

  // Storage
  S('s3', 'Amazon S3', 'storage', ['@aws-sdk/client-s3', 'aws-sdk', 'boto3'], 'Stores files in the cloud. Each file gets an address, and access is controlled by rules you set.', { env: /^AWS_|^S3_/, host: /amazonaws\.com/ }),
  S('r2', 'Cloudflare R2', 'storage', ['@cloudflare/*'], 'Stores files in the cloud on Cloudflare.', { env: /^R2_|CLOUDFLARE/ }),
  S('vercel-blob', 'Vercel Blob', 'storage', ['@vercel/blob'], 'Stores uploaded files on Vercel.', { env: /BLOB_/ }),
  S('uploadthing', 'UploadThing', 'storage', ['uploadthing', '@uploadthing/*'], 'Handles file uploads for you.', { env: /UPLOADTHING/ }),
  S('cloudinary', 'Cloudinary', 'storage', ['cloudinary'], 'Stores images and video, and resizes them on demand.', { env: /CLOUDINARY/, host: /cloudinary\.com/ }),

  // Queues and background work
  S('temporal', 'Temporal', 'queue', ['@temporalio/*', 'temporalio'], 'Runs long multi-step jobs and resumes them where they stopped if something crashes.', { env: /TEMPORAL/ }),
  S('inngest', 'Inngest', 'queue', ['inngest'], 'Runs background jobs triggered by events, with retries.', { env: /INNGEST/ }),
  S('bullmq', 'BullMQ', 'queue', ['bullmq', 'bull'], 'A job queue on Redis: work is put in a line and done in the background.'),
  S('celery', 'Celery', 'queue', ['celery'], 'Runs Python work in the background through a queue.'),

  // Observability and analytics
  S('sentry', 'Sentry', 'monitoring', ['@sentry/*', 'sentry-sdk'], 'Records errors that happen in production and tells you about them. Error reports leave your server, so check what they contain.', { env: /SENTRY/, host: /sentry\.io/ }),
  S('posthog', 'PostHog', 'analytics', ['posthog-js', 'posthog-node', 'posthog'], 'Records what people do in your app so you can see how it is used.', { env: /POSTHOG/, host: /posthog\.com/ }),
  S('vercel-analytics', 'Vercel Analytics', 'analytics', ['@vercel/analytics', '@vercel/speed-insights'], 'Counts page views and measures speed.'),
  S('plausible', 'Plausible', 'analytics', ['plausible-tracker', 'next-plausible'], 'Privacy-friendly page view counting.', { host: /plausible\.io/ }),

  // Web and other outside APIs
  S('browserbase', 'Browserbase', 'web', ['@browserbasehq/*'], 'Runs real web browsers in the cloud for your code to control.', { env: /BROWSERBASE/, host: /browserbase\.com/ }),
  S('serpapi', 'SerpApi', 'web', ['serpapi', 'google-search-results'], 'Returns Google search results to your code as data.', { env: /SERP/, host: /serpapi\.com/ }),
  S('googlemaps', 'Google Maps', 'maps', ['@googlemaps/*', '@react-google-maps/*', '@vis.gl/react-google-maps'], 'Maps, places and directions from Google. Billed per request past a free tier.', { env: /GOOGLE_MAPS/, host: /maps\.googleapis/ }),
  S('mapbox', 'Mapbox', 'maps', ['mapbox-gl', 'react-map-gl'], 'Draws interactive maps. Billed by map loads past a free tier.', { env: /MAPBOX/, host: /mapbox\.com/ }),
  E('leaflet', 'Leaflet', 'ui', ['leaflet', 'react-leaflet'], 'Draws interactive maps in the browser. Free and open source; the map pictures come from a tile provider.'),
  E('maplibre', 'MapLibre', 'ui', ['maplibre-gl'], 'Draws interactive maps in the browser. An open source fork of Mapbox.'),
  S('github-api', 'GitHub', 'other', ['@octokit/*', 'octokit'], 'Lets your code read and change things on GitHub.', { env: /^GITHUB_|^GH_/, host: /api\.github\.com/ }),
  S('solana', 'Solana', 'blockchain', ['@solana/*'], 'A public blockchain. Writes are permanent, public and cost a small fee.', { env: /SOLANA|HELIUS/, host: /solana\.com|helius/ }),
  S('ethereum', 'Ethereum', 'blockchain', ['ethers', 'viem', 'wagmi', 'web3'], 'A public blockchain. Writes are permanent, public and cost a fee.', { env: /ALCHEMY|INFURA/ }),

  // UI, styling, state
  E('tailwind', 'Tailwind CSS', 'styling', ['tailwindcss', '@tailwindcss/*'], 'Styling through short class names written directly on each element, instead of separate CSS files.'),
  E('shadcn', 'shadcn/ui parts', 'ui', ['@radix-ui/*', 'class-variance-authority', 'cmdk', 'vaul', 'sonner'], 'Ready-made accessible interface pieces like dialogs and menus. shadcn/ui copies them into your own project.'),
  E('mui', 'Material UI', 'ui', ['@mui/*'], 'A large set of ready-made React components in Google\'s Material style.'),
  E('chakra', 'Chakra UI', 'ui', ['@chakra-ui/*'], 'A set of ready-made React components.'),
  E('motion', 'Motion', 'ui', ['framer-motion', 'motion'], 'Animation for React: things that slide, fade and spring.'),
  E('gsap', 'GSAP', 'ui', ['gsap', '@gsap/*'], 'A library for detailed animation, often tied to scrolling.'),
  E('three', 'Three.js', 'ui', ['three', '@react-three/*'], 'Draws 3D scenes in the browser.'),
  E('recharts', 'Charts', 'ui', ['recharts', 'chart.js', 'react-chartjs-2', 'd3', 'visx'], 'Draws charts and graphs from your data.'),
  E('zustand', 'Zustand', 'state', ['zustand'], 'A small shared memory for your screens, so different components can read the same data.'),
  E('redux', 'Redux', 'state', ['redux', '@reduxjs/toolkit', 'react-redux'], 'A central store for screen data with strict rules about how it changes.'),
  E('tanstack-query', 'TanStack Query', 'state', ['@tanstack/react-query'], 'Fetches data from your server and remembers it, so screens stay up to date without you writing the loading logic.'),
  E('swr', 'SWR', 'state', ['swr'], 'Fetches data and keeps it fresh in the background.'),
  E('react-hook-form', 'React Hook Form', 'library', ['react-hook-form'], 'Keeps track of what is typed into a form and whether it is valid.'),
  E('icons', 'Icons', 'ui', ['lucide-react', '@phosphor-icons/*', 'react-icons', '@heroicons/*', '@tabler/icons-react'], 'A set of icons used in the interface.'),

  // Validation
  E('zod', 'Zod', 'validation', ['zod'], 'Checks that data has the shape you expect before your code uses it. Anything arriving from outside should go through something like this.', { analogy: 'A bouncer with a checklist.' }),
  E('pydantic', 'Pydantic', 'validation', ['pydantic'], 'Checks that Python data has the shape you described.'),
  E('joi', 'Validators', 'validation', ['joi', 'yup', 'valibot', 'ajv', 'class-validator', 'express-validator'], 'Checks that data has the shape you expect before your code uses it.'),

  // Tests and tooling
  E('vitest', 'Vitest', 'testing', ['vitest'], 'Runs automated tests. It is only used while developing.'),
  E('jest', 'Jest', 'testing', ['jest', 'ts-jest'], 'Runs automated tests. It is only used while developing.'),
  E('playwright', 'Playwright', 'testing', ['@playwright/test', 'playwright', 'playwright-core'], 'Drives a real browser from code, usually to test your app by clicking through it.'),
  E('cypress', 'Cypress', 'testing', ['cypress'], 'Tests your app by clicking through it in a browser.'),
  E('pytest', 'pytest', 'testing', ['pytest'], 'Runs automated tests in Python.'),
  E('eslint', 'ESLint', 'tooling', ['eslint', 'eslint-*', '@eslint/*', 'typescript-eslint'], 'Reads your code and points out likely mistakes. It does not run in the app.'),
  E('prettier', 'Prettier', 'tooling', ['prettier'], 'Formats your code so it looks consistent. It does not change what the code does.'),
  E('biome', 'Biome', 'tooling', ['@biomejs/*'], 'Formats your code and points out likely mistakes.'),
  E('tsx', 'tsx', 'tooling', ['tsx', 'ts-node', 'nodemon'], 'Runs TypeScript directly during development, without a build step.'),
  E('dotenv', 'dotenv', 'tooling', ['dotenv', 'python-dotenv'], 'Loads settings and secrets from a .env file when the app starts.'),
  E('cors', 'CORS', 'library', ['cors', '@fastify/cors'], 'Tells browsers which other websites may call your server.'),
  E('helmet', 'Helmet', 'library', ['helmet'], 'Adds browser security settings to every response.'),
  E('sharp', 'sharp', 'library', ['sharp', 'pillow', 'Pillow'], 'Resizes and converts images.'),
  E('pdf', 'PDF tools', 'library', ['pdf-lib', 'pdfjs-dist', 'pdf-parse', 'pypdf', 'pymupdf', 'PyMuPDF', 'pdfplumber'], 'Reads or creates PDF files.'),
  E('numpy', 'NumPy', 'library', ['numpy'], 'Fast maths on large tables of numbers in Python.'),
  E('pandas', 'pandas', 'library', ['pandas'], 'Spreadsheet-style data tables in Python.'),
  E('pytorch', 'PyTorch', 'library', ['torch'], 'The library most AI models are built and run with. It needs a lot of memory.'),
  E('requests', 'HTTP clients', 'library', ['requests', 'httpx', 'aiohttp', 'axios', 'ky', 'got', 'node-fetch', 'undici'], 'Makes requests to other servers on the internet.'),
];

const exact = new Map<string, CatalogEntry>();
const prefix: Array<[string, CatalogEntry]> = [];
for (const e of CATALOG) {
  for (const m of e.match) {
    if (m.endsWith('*')) prefix.push([m.slice(0, -1), e]);
    else exact.set(m, e);
  }
}

export function catalogFor(pkg: string): CatalogEntry | null {
  const direct = exact.get(pkg);
  if (direct) return direct;
  const root = pkg.startsWith('@') ? pkg.split('/').slice(0, 2).join('/') : pkg.split('/')[0];
  const r = exact.get(root);
  if (r) return r;
  for (const [p, e] of prefix) if (pkg.startsWith(p)) return e;
  return null;
}

export function catalogById(id: string): CatalogEntry | undefined {
  return CATALOG.find((e) => e.id === id);
}

/** Which catalogued service does this URL host belong to? */
export function serviceForHost(host: string): CatalogEntry | null {
  for (const e of CATALOG) if (e.host?.test(host)) return e;
  return null;
}

export function serviceForEnv(name: string): CatalogEntry | null {
  for (const e of CATALOG) if (e.service && e.env?.test(name)) return e;
  return null;
}
