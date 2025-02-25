const fs = require("fs");
const ut = require("../node/util.js");
const Ajv2020 = require("ajv/dist/2020.js").default;
const addFormats = require("ajv-formats");
const jsonSourceMap = require("json-source-map");

const _IS_SORT_RESULTS = !process.env.VET_TEST_JSON_RESULTS_UNSORTED;
const _IS_TRIM_RESULTS = !process.env.VET_TEST_JSON_RESULTS_UNTRIMMED;

// Compile the schema
require("../node/compile-schemas.js");

// region Set up validator
const ajv = new Ajv2020({
	allowUnionTypes: true,
});
addFormats(ajv);

ajv.addKeyword({
	keyword: "version",
	validate: false,
});

const DATE_REGEX = /^\d\d\d\d-\d\d-\d\d$/;
ajv.addFormat(
	"date",
	{
		validate: (str) => DATE_REGEX.test(str),
	},
);
// endregion

function handleError (data) {
	const outRaw = JSON.stringify(ajv.errors, null, 2);

	// Sort the deepest errors to the bottom, as these are the ones we're most likely to be the ones we care about
	//   manually checking.
	if (_IS_SORT_RESULTS) {
		ajv.errors.sort((a, b) => (a.instancePath.length ?? -1) - (b.instancePath.length ?? -1));
	}

	// If there are an excessive number of errors, it's probably a junk entry; show only the first error and let the
	//   user figure it out.
	if (_IS_TRIM_RESULTS && ajv.errors.length > 5) {
		console.error(`(${ajv.errors.length} errors found, showing (hopefully) most-relevant one\u2014see the "log-test-json.json" file for the rest.)`);
		ajv.errors = ajv.errors.slice(-1);
	}

	// Add line numbers
	const sourceMap = jsonSourceMap.stringify(data, null, "\t");
	ajv.errors.forEach(it => {
		const errorPointer = sourceMap.pointers[it.instancePath];
		it.lineNumberStart = errorPointer.value.line;
		it.lineNumberEnd = errorPointer.valueEnd.line;
	});

	const out = ajv.errors.map(it => JSON.stringify(it, null, 2)).join("\n");
	console.error(out);
	console.warn(`Tests failed`);

	fs.writeFileSync("../log-test-json.json", outRaw, "utf-8");

	return false;
}

// add any implicit data to the JSON
function addImplicits (obj, lastKey) {
	if (typeof obj !== "object") return;
	if (obj == null) return;
	if (obj instanceof Array) obj.forEach(it => addImplicits(it, lastKey));
	else {
		// "obj.mode" will be set if this is in a "_copy" etc. block
		if (lastKey === "spellcasting" && !obj.mode) obj.type = obj.type || "spellcasting";

		Object.entries(obj).forEach(([k, v]) => addImplicits(v, k));
	}
}

async function main () {
	console.log(`##### Validating JSON against schemata #####`);

	// a probably-unnecessary directory shift to ensure the JSON schema internal references line up
	const cacheDir = process.cwd();
	process.chdir(`${cacheDir}/test/schema`);

	ut.listFiles({dir: ".", blocklistFilePrefixes: []})
		.forEach(f => {
			const fId = f.replace(/^\.\//, "");
			ajv.addSchema(ut.readJson(f, "utf8"), fId);
		});

	// Get schema files, ignoring directories
	const schemaFiles = fs.readdirSync(`${cacheDir}/test/schema`)
		.filter(file => file.endsWith(".json"));

	const SCHEMA_BLOCKLIST = new Set([
		"entry.json",
		"util.json",
		"items-shared.json",
		"homebrew.json",
	]);

	for (let i = 0; i < schemaFiles.length; ++i) {
		const schemaFile = schemaFiles[i];
		if (SCHEMA_BLOCKLIST.has(schemaFile)) continue;

		const dataFile = schemaFile; // data and schema filenames match

		console.log(`Testing data/${dataFile}`.padEnd(50), `against schema/${schemaFile}`);

		const data = ut.readJson(`${cacheDir}/data/${dataFile}`);

		addImplicits(data);
		const valid = ajv.validate(schemaFile, data);
		if (!valid) return handleError(data);
	}

	// Get schema files in directories
	const schemaDirectories = fs.readdirSync(`${cacheDir}/test/schema`)
		.filter(category => !category.includes("."));

	for (let i = 0; i < schemaDirectories.length; ++i) {
		const schemaDir = schemaDirectories[i];
		console.log(`Testing category ${schemaDir}`);
		const schemaFiles = fs.readdirSync(`${cacheDir}/test/schema/${schemaDir}`);

		const dataFiles = fs.readdirSync(`${cacheDir}/data/${schemaDir}`);
		for (let i = 0; i < dataFiles.length; ++i) {
			const dataFile = dataFiles[i];

			const relevantSchemaFiles = schemaFiles.filter(schema => dataFile.startsWith(schema.split(".")[0]));
			for (let i = 0; i < relevantSchemaFiles.length; ++i) {
				const schemaFile = relevantSchemaFiles[i];
				const schemaKey = `${schemaDir}/${schemaFile}`;

				console.log(`Testing data/${schemaDir}/${dataFile}`.padEnd(50), `against schema/${schemaDir}/${schemaFile}`);

				const data = ut.readJson(`${cacheDir}/data/${schemaDir}/${dataFile}`);

				addImplicits(data);
				const valid = ajv.validate(schemaKey, data);
				if (!valid) return handleError(data);
			}
		}
	}

	console.log(`All schema tests passed.`);
	process.chdir(cacheDir); // restore working directory

	return true;
}

module.exports = main();
