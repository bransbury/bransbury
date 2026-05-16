import { readFile, writeFile } from 'node:fs/promises';

const username = process.env.GITHUB_USERNAME || process.argv[2] || 'bransbury';
const readmePath = process.env.README_PATH || process.argv[3] || 'README.md';
const profileStatsToken = process.env.PROFILE_STATS_TOKEN;
const token = profileStatsToken || process.env.GITHUB_TOKEN;
const includePrivateStats = process.env.INCLUDE_PRIVATE_STATS === 'true' && Boolean(profileStatsToken);
const currentYear = new Date().getUTCFullYear();

const headers = {
  'User-Agent': `${username}-profile-readme-updater`,
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

async function requestText(url, extraHeaders = {}) {
  const response = await fetch(url, {
    headers: {
      ...headers,
      ...extraHeaders,
    },
  });

  if (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0') {
    throw new Error('GitHub API rate limit exceeded. Set GITHUB_TOKEN for local runs or wait for the limit window to reset.');
  }

  if (!response.ok) {
    throw new Error(`Request failed for ${url}: ${response.status} ${response.statusText}`);
  }

  return response.text();
}

function formatNumber(value) {
  return new Intl.NumberFormat('en-US').format(value);
}

function encodeBadgeLabel(value) {
  return encodeURIComponent(String(value).replace(/-/g, '--'));
}

function badge(label, message, link, color = '181717') {
  const labelText = encodeBadgeLabel(label);
  const messageText = encodeBadgeLabel(message);

  return `  <a href="${link}"><img alt="${label}: ${message}" src="https://img.shields.io/badge/${labelText}-${messageText}-${color}?style=for-the-badge&logo=github" /></a>`;
}

async function paginateRepos() {
  const repositories = [];

  for (let page = 1; page <= 10; page += 1) {
    const url = includePrivateStats && token
      ? `https://api.github.com/user/repos?per_page=100&page=${page}&visibility=all&affiliation=owner&sort=updated`
      : `https://api.github.com/users/${username}/repos?per_page=100&page=${page}&type=owner&sort=updated`;
    const pageItems = await requestJson(url);

    if (!Array.isArray(pageItems) || pageItems.length === 0) {
      break;
    }

    repositories.push(...pageItems);

    if (pageItems.length < 100) {
      break;
    }
  }

  return repositories.filter((repository) => !repository.fork);
}

async function fetchMergedPrCount() {
  const qualifiers = [`author:${username}`, 'type:pr', 'is:merged'];

  if (!includePrivateStats || !token) {
    qualifiers.push('is:public');
  }

  const searchUrl = `https://api.github.com/search/issues?q=${encodeURIComponent(qualifiers.join(' '))}`;
  const response = await requestJson(searchUrl);
  return response.total_count ?? 0;
}

async function fetchContributionsThisYear() {
  const from = `${currentYear}-01-01`;
  const to = `${currentYear}-12-31`;
  const html = await requestText(`https://github.com/users/${username}/contributions?from=${from}&to=${to}`, {
    Accept: 'text/html',
  });

  const summaryMatch = html.match(/<h2[^>]*id="js-contribution-activity-description"[^>]*>\s*([\d,]+)\s*contributions?\s*in\s*\d{4}\s*<\/h2>/i);

  if (summaryMatch) {
    return Number.parseInt(summaryMatch[1].replace(/,/g, ''), 10);
  }

  const match = html.match(/([\d,]+) contributions? in \d{4}/i);

  if (!match) {
    throw new Error(`Unable to parse contributions for ${currentYear}`);
  }

  return Number.parseInt(match[1].replace(/,/g, ''), 10);
}

async function fetchLanguageTotals(repositories) {
  const totals = new Map();

  for (const repository of repositories) {
    const languageMap = await requestJson(repository.languages_url);

    for (const [language, bytes] of Object.entries(languageMap)) {
      totals.set(language, (totals.get(language) || 0) + bytes);
    }
  }

  return [...totals.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 5)
    .map(([language]) => language);
}

function buildStatsBlock(data) {
  const repoLabel = data.includesPrivateStats ? 'Owned repos' : 'Public repos';
  const starsLabel = data.includesPrivateStats ? 'Stars across owned repos' : 'Public repo stars';
  const mergedPrLabel = data.includesPrivateStats ? 'Merged pull requests accessible to token' : 'Merged pull requests';
  const contributionsLabel = data.includesPrivateStats ? `Contributions in ${currentYear} shown on profile` : `Contributions in ${currentYear}`;
  const badges = [
    badge('Followers', data.followers, `https://github.com/${username}?tab=followers`),
    badge('Following', data.following, `https://github.com/${username}?tab=following`),
    badge(repoLabel, data.repoCount, `https://github.com/${username}?tab=repositories`),
    badge('Stars', data.totalStars, `https://github.com/${username}?tab=repositories&sort=stargazers`),
    badge('Merged PRs', data.mergedPullRequests, `https://github.com/pulls?q=is%3Apr+author%3A${username}+is%3Amerged`),
    badge(`${currentYear} contributions`, data.contributionsThisYear, `https://github.com/${username}`),
    badge('On GitHub since', data.onGitHubSince, `https://github.com/${username}`),
  ];

  return [
    '<!-- profile-stats:start -->',
    '<p align="center">',
    ...badges,
    '</p>',
    '',
    '## 🚀 GitHub Snapshot',
    '',
    `- **Most-starred repo:** ${data.mostStarredRepo.label}`,
    `- **Languages across owned repos:** ${data.topLanguages.join(' · ')}`,
    `- **${starsLabel}:** ${formatNumber(data.totalStars)}`,
    `- **${mergedPrLabel}:** ${formatNumber(data.mergedPullRequests)}`,
    `- **${contributionsLabel}:** ${formatNumber(data.contributionsThisYear)}`,
    `- **On GitHub since:** ${data.onGitHubSince}`,
    data.includesPrivateStats
      ? '- **Private stats mode:** enabled via repository secret; private repository names are not exposed.'
      : '- **Private stats mode:** disabled; stats are based on public GitHub data only.',
    '<!-- profile-stats:end -->',
  ].join('\n');
}

async function main() {
  const [user, repositories, mergedPullRequests, contributionsThisYear, readme] = await Promise.all([
    includePrivateStats && token
      ? requestJson('https://api.github.com/user')
      : requestJson(`https://api.github.com/users/${username}`),
    paginateRepos(),
    fetchMergedPrCount(),
    fetchContributionsThisYear(),
    readFile(readmePath, 'utf8'),
  ]);

  const totalStars = repositories.reduce((sum, repository) => sum + repository.stargazers_count, 0);
  const mostStarredRepo = repositories.reduce((best, repository) => {
    if (!best || repository.stargazers_count > best.stars) {
      return {
        name: repository.name,
        url: repository.html_url,
        stars: repository.stargazers_count,
        private: repository.private,
      };
    }

    return best;
  }, null);

  const topLanguages = await fetchLanguageTotals(repositories);
  const onGitHubSince = new Date(user.created_at).getUTCFullYear();
  const mostStarredRepoLabel = mostStarredRepo.private
    ? `Private repository (${formatNumber(mostStarredRepo.stars)} star${mostStarredRepo.stars === 1 ? '' : 's'})`
    : `[${mostStarredRepo.name}](${mostStarredRepo.url}) (${formatNumber(mostStarredRepo.stars)} star${mostStarredRepo.stars === 1 ? '' : 's'})`;
  const statsBlock = buildStatsBlock({
    followers: user.followers ?? 0,
    following: user.following ?? 0,
    repoCount: includePrivateStats && token
      ? repositories.length
      : (user.public_repos ?? repositories.length),
    totalStars,
    mergedPullRequests,
    contributionsThisYear,
    onGitHubSince,
    includesPrivateStats: includePrivateStats && Boolean(token),
    mostStarredRepo: {
      ...mostStarredRepo,
      label: mostStarredRepoLabel,
    },
    topLanguages,
  });

  const statsPattern = /<!-- profile-stats:start -->[\s\S]*<!-- profile-stats:end -->/;

  if (!statsPattern.test(readme)) {
    throw new Error('README is missing the profile stats markers.');
  }

  const updatedReadme = readme.replace(statsPattern, statsBlock);

  await writeFile(readmePath, updatedReadme);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});