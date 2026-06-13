import "dotenv/config";
import dns from "node:dns";
dns.setServers(["8.8.8.8", "1.1.1.1"]);
import { connectDatabase, closeDatabase, getCollections } from "./db.js";

async function main() {
  await connectDatabase();
  try {
    const { candidatesCollection } = getCollections();
    const count = await candidatesCollection.countDocuments({});
    console.log("Total candidates:", count);

    const successCount = await candidatesCollection.countDocuments({ embeddingStatus: "success" });
    console.log("Success candidates:", successCount);

    const failedCount = await candidatesCollection.countDocuments({ embeddingStatus: "failed" });
    console.log("Failed candidates:", failedCount);

    if (failedCount > 0) {
      console.log("Sample failed candidates:");
      const samples = await candidatesCollection.find({ embeddingStatus: "failed" }).limit(5).toArray();
      samples.forEach(s => {
        console.log(`- Candidate: ${s.name}, Error: ${s.embeddingError}`);
      });
    }
  } catch (err) {
    console.error(err);
  } finally {
    await closeDatabase();
  }
}

main();
