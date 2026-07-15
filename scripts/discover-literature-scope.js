const fs = require("fs");
const https = require("https");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi";
const DATE_RANGE = "2006:2026[dp]";

const TERM_SETS = {
  coreTitle: [
    '"venous thromboembolism"[ti]',
    '"deep vein thrombosis"[ti]',
    '"deep venous thrombosis"[ti]',
    '"pulmonary embolism"[ti]',
    '"venous thrombosis"[ti]',
    '"pulmonary artery embolism"[ti]',
  ],
  expandedTitleAbstract: [
    '"venous thromboembolism"[tiab]',
    '"deep vein thrombosis"[tiab]',
    '"deep venous thrombosis"[tiab]',
    '"pulmonary embolism"[tiab]',
    '"venous thrombosis"[tiab]',
    '"pulmonary artery embolism"[tiab]',
  ],
  mesh: [
    '"Venous Thromboembolism"[mh]',
    '"Pulmonary Embolism"[mh]',
    '"Venous Thrombosis"[mh]',
  ],
};

const TOPIC_FILTERS = {
  all: "",
  guidelineReviewMeta: ' AND (guideline[pt] OR review[pt] OR systematic review[pt] OR meta-analysis[pt])',
  aiPrediction: ' AND ("artificial intelligence"[tiab] OR "machine learning"[tiab] OR "deep learning"[tiab] OR prediction[tiab] OR model[tiab] OR nomogram[tiab])',
  imagingDiagnosis: ' AND (CTPA[tiab] OR "computed tomography pulmonary angiography"[tiab] OR ultrasound[tiab] OR imaging[tiab] OR diagnosis[tiab])',
  preventionProphylaxis: ' AND (prevention[tiab] OR prophylaxis[tiab] OR thromboprophylaxis[tiab])',
  anticoagulationBleeding: ' AND (anticoagulation[tiab] OR anticoagulant[tiab] OR heparin[tiab] OR warfarin[tiab] OR rivaroxaban[tiab] OR bleeding[tiab])',
  interventionPERT: ' AND (PERT[tiab] OR catheter[tiab] OR thrombectomy[tiab] OR thrombolysis[tiab] OR filter[tiab] OR endovascular[tiab])',
  realWorldCohort: ' AND ("real-world"[tiab] OR cohort[tiab] OR registry[tiab] OR epidemiology[tiab])',
};

function requestJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          "User-Agent": "VTE-Agent-MVP-literature-discovery/0.1 (local research)",
        },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(60_000, () => {
      req.destroy(new Error("NCBI request timeout"));
    });
  });
}

function buildQuery(termSet, topicFilter) {
  return `(${termSet.join(" OR ")}) AND ${DATE_RANGE}${topicFilter}`;
}

async function countQuery(name, query) {
  const params = new URLSearchParams({
    db: "pubmed",
    term: query,
    retmode: "json",
    retmax: "0",
  });
  const result = await requestJson(`${EUTILS}?${params.toString()}`);
  return {
    name,
    query,
    count: Number(result.esearchresult.count || 0),
    queryTranslation: result.esearchresult.querytranslation || "",
  };
}

async function main() {
  const rows = [];
  for (const [termSetName, terms] of Object.entries(TERM_SETS)) {
    for (const [topicName, filter] of Object.entries(TOPIC_FILTERS)) {
      const name = `${termSetName}:${topicName}`;
      const query = buildQuery(terms, filter);
      console.log(`Counting ${name}`);
      rows.push(await countQuery(name, query));
      await new Promise((resolve) => setTimeout(resolve, 380));
    }
  }

  const output = {
    generatedAt: new Date().toISOString(),
    database: "PubMed",
    dateRange: DATE_RANGE,
    note: "Counts only. Use this to decide harvesting scope before fetching full records.",
    rows,
  };
  const outPath = path.join(DATA_DIR, "pubmed-discovery-counts.json");
  fs.writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(output, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
