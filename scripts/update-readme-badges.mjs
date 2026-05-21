import { readFile, writeFile } from 'node:fs/promises';

const username = process.env.GITHUB_USERNAME || process.argv[2] || 'bransbury';
const readmePath = process.env.README_PATH || process.argv[3] || 'README.md';
const token = process.env.GITHUB_TOKEN;

const headers = {
  'User-Agent': `${username}-readme-badge-updater`,
  Accept: 'application/vnd.github+json',
};

if (token) {
  headers.Authorization = `Bearer ${token}`;
}

async function requestJson(url) {
  const response = await fetch(url, { headers });

  if (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0') {
    throw new Error('GitHub API rate limit exceeded. Set GITHUB_TOKEN for local runs or wait for the limit window to reset.');
  }

  if (!response.ok) {
    throw new Error(`Request failed for ${url}: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

function encodeBadgeValue(value) {
  return encodeURIComponent(String(value).replace(/-/g, '--'));
}

function replaceBadge(readme, { href, altLabel, message, color }) {
  const encodedMessage = encodeBadgeValue(message);
  const pattern = new RegExp(
    `(<a href="${href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}">\\s*<img alt="${altLabel}: )[^"]+(" src="https://img\\.shields\\.io/badge/[^-]+-)[^?]+(\\?style=for-the-badge&logo=github" \\/>\\s*<\\/a>)`,
    'g',
  );

  if (!pattern.test(readme)) {
    throw new Error(`README badge not found for ${altLabel}.`);
  }

  pattern.lastIndex = 0;

  return readme.replace(
    pattern,
    `$1${message}$2${encodedMessage}-${color}$3`,
  );
}

async function main() {
  const [user, readme] = await Promise.all([
    requestJson(`https://api.github.com/users/${username}`),
    readFile(readmePath, 'utf8'),
  ]);

  const onGitHubSince = new Date(user.created_at).getUTCFullYear();

  let updatedReadme = readme;
  updatedReadme = replaceBadge(updatedReadme, {
    href: `https://github.com/${username}?tab=followers`,
    altLabel: 'Followers',
    message: user.followers ?? 0,
    color: '0969da',
  });
  updatedReadme = replaceBadge(updatedReadme, {
    href: `https://github.com/${username}?tab=repositories`,
    altLabel: 'Public repos',
    message: user.public_repos ?? 0,
    color: '8250df',
  });
  updatedReadme = replaceBadge(updatedReadme, {
    href: `https://github.com/${username}`,
    altLabel: 'On GitHub since',
    message: onGitHubSince,
    color: '57606a',
  });

  await writeFile(readmePath, updatedReadme);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
