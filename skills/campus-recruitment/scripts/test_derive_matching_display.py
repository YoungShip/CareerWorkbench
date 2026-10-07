from __future__ import annotations
import json, subprocess, sys, tempfile, unittest
from pathlib import Path

SCRIPT=Path(__file__).with_name("derive_matching_display.py")

def req(category,support,conclusion):
    return {"category":category,"support":support,"conclusion":conclusion}

def pos(pid,title,requirements,decision,excluded=False):
    return {"id":pid,"title":title,"city":"南京","requirements":requirements,
            "decision":{"state":decision,"reason":"fixture"},"excluded":excluded}

class DisplaySummaryTests(unittest.TestCase):
    def derive(self,positions):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d); inp=root/"in.json"; out=root/"out.json"
            inp.write_text(json.dumps({"positions":positions}),encoding="utf-8")
            p=subprocess.run([sys.executable,"-X","utf8",str(SCRIPT),str(inp),str(out)],capture_output=True)
            self.assertEqual(p.returncode,0,(p.stdout+p.stderr).decode("utf-8",errors="replace"))
            return json.loads(out.read_text(encoding="utf-8"))["positions"]

    def test_intuitive_grades_and_ranges(self):
        software=[
            req("hard_qualification","direct_support","satisfied"),
            req("core_capability","direct_support","satisfied"),
            req("core_capability","transferable","pending"),
            req("plus","no_evidence","pending"),
            req("core_capability","direct_support","satisfied"),
            req("core_capability","direct_support","satisfied"),
        ]
        data=[
            req("hard_qualification","direct_support","satisfied"),
            req("core_capability","transferable","pending"),
            req("core_capability","conflict","pending"),
            req("core_capability","transferable","pending"),
            req("core_capability","no_evidence","pending"),
            req("plus","direct_support","satisfied"),
        ]
        aiot=[
            req("hard_qualification","direct_support","satisfied"),
            req("core_capability","transferable","pending"),
            req("core_capability","conflict","pending"),
            req("plus","transferable","pending"),
            req("core_capability","direct_support","satisfied"),
            req("core_capability","direct_support","satisfied"),
            req("plus","transferable","pending"),
        ]
        rows=self.derive([
            pos("software","Software",software,"consider"),
            pos("data","Data",data,"pending"),
            pos("aiot","AIoT",aiot,"pending"),
            pos("excluded","Product",[req("hard_qualification","direct_support","satisfied")],"excluded",True),
        ])
        by={r["id"]:r for r in rows}
        self.assertEqual((by["software"]["grade"],by["software"]["evidence_match_range"]),("A","85-90%"))
        self.assertEqual((by["data"]["grade"],by["data"]["evidence_match_range"]),("C","50-55%"))
        self.assertEqual((by["aiot"]["grade"],by["aiot"]["evidence_match_range"]),("B","70-75%"))
        self.assertEqual(by["excluded"]["grade"],"C")
        self.assertTrue(by["software"]["registerable"])
        self.assertFalse(by["aiot"]["registerable"])

if __name__=="__main__":
    unittest.main()
