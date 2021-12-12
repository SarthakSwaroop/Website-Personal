const _path = require('path');
const _fs = require('fs');
const _git = require('nodegit');
const _fetch = require('node-fetch');
const _jsyaml = require('js-yaml');
const _javadoc = require('mdjavadoc-api');
const { Client } = require('git-rest-wrapper');

const _gitrest = new Client({
	cache: {
		type: "disk"
	},
	tokens: {
		"api.github.com": process.env.GITHUB_TOKEN
	}
});
const _site = require("./meta.json");

const _projects = [];
const _wikis = [];
const _docs = [];

function getAllFiles(dir, callback) {
	_fs.readdirSync(dir).forEach((file) => {
		const filePath = _path.resolve(dir, file);
		if (_fs.statSync(filePath).isDirectory())
			getAllFiles(filePath, callback);
		else callback(filePath);
	})
}

async function getRepoProject(repo) {
	let id = repo.id.split("/").pop().toLowerCase();

	let rawUrl = `${repo.url}/raw/branch/${repo.defaultBranch}`;
	let fileUrl = `${repo.url}/src/branch/${repo.defaultBranch}`;

	if (repo.provider == "github") {
		rawUrl = `https://raw.githubusercontent.com/${repo.id}/${repo.defaultBranch}`;
		fileUrl = `${repo.url}/blob/${repo.defaultBranch}`;
	}

	// clone repo into temp dir
	await _fs.promises.rmdir("/tmp/" + id, { recursive: true });
	await _fs.promises.rmdir(`/tmp/mdjavadoc-${id}`, { recursive: true });
	_fs.mkdirSync("/tmp/" + id);

	await _git.Clone(repo.gitUrlHttp, "/tmp/" + id);

	// get readme from repo
	let readme = _fs.readFileSync(`/tmp/${id}/README.md`, "utf8");

	// extract title from readme (if possible)
	let titleRegex = (/^[\w-., ]+/g).exec(readme);
	let title = repo.id.split("/").pop();
	if (titleRegex && readme.includes("=====")) {
		title = titleRegex[0].trim();
	}

	// clean up readme text & fix relative URLs
	readme = readme.split(/={5,}/g).pop();
	readme = readme.split("</p>").pop();
	readme = readme.replace(/\!\[([A-Za-z0-9.`'"\/ ]*)\]\((\.[A-Za-z0-9\/\-\.\?\=]*)\)/g, "![$1](" + rawUrl + "/$2)");
	readme = readme.replace(/\[([A-Za-z0-9.`'"\/ ]*)\]\((\.[A-Za-z0-9\/\-\.\?\=]*)\)/g, "[$1](" + fileUrl + "/$2)");

	// read metadata
	let meta = {};
	try {
		let metaYaml = _fs.readFileSync(`/tmp/${id}/.meta.yml`, "utf8");
		meta = _jsyaml.safeLoad(metaYaml);
	} catch (e) {}

	let screenshots = (meta.screenshots || []).map((url) => `${rawUrl}/${url}`);
	let icon = meta.icon ? `${rawUrl}/${meta.icon}` : null;

	// generate docs
	const files = _javadoc.generateMarkdownFiles("/tmp/" + id, `/tmp/mdjavadoc-${id}`, {
		reg: /.*(\.java|\.kt|\.js)$/,
		index: "index.md",
		sourcePrefix: fileUrl
	});

	let hasDocs = files.length > 0;
	getAllFiles(`/tmp/mdjavadoc-${id}`, (filePath) => {
		const path = filePath.substring(`/tmp/mdjavadoc-${id}`.length);
		_docs.push({
			id,
			title,
			path: path.split(".")[0],
			content: _fs.readFileSync(filePath, "utf8")
		});
	});

	let project = {
		id,
		repo,
		title,
		icon,
		screenshots,
		readme,
		hasWiki: false,
		hasDocs
	};

	_projects.push(project);
	return project;
}

async function getRepoWiki(repo, project) {
	let id = repo.id.split("/").pop().toLowerCase();

	let wikiDir = "/tmp/" + id + ".wiki";

	// clone repo into temp dir
	await _fs.promises.rmdir(wikiDir, { recursive: true });
	_fs.mkdirSync(wikiDir);

	try {
		await _git.Clone(repo.gitUrlHttp.replace(".git", ".wiki.git"), wikiDir);
	} catch (e) {
		return;
	}

	_fs.readdirSync(wikiDir).filter((fileName) => fileName.endsWith(".md")).forEach((fileName) => {
		let content = _fs.readFileSync(`${wikiDir}/${fileName}`, "utf8");
		content = content.replace(/\[([\w.`'" ]*)\]\((?:\.\/)?([\w-]*)(#[\w-]*)?\)/g, "[$1]($2.html$3)");

		project.hasWiki = true;
		_wikis.push({
			id,
			repo: repo,
			project: project,
			page: fileName == "Home.md" ? "index" : fileName.replace(".md", ""),
			title: fileName.replace(".md", "").replace(/[-_]/g, " "),
			content
		});
	});
}

async function getRepo(repoId) {
	let repo = await _gitrest.getRepo(repoId);
	if (!repo) return;

	let project = await getRepoProject(repo);
	await getRepoWiki(repo, project);
}

module.exports = async function() {
	let repos = await Promise.all(_site.repos.map(getRepo));

	return {
		projects: _projects,
		wikis: _wikis,
		docs: _docs
	};
}
