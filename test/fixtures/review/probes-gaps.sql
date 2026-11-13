-- D-9 probe/gap comparison fixture (synthetic).
-- The production seed is empty in capability_gaps and turn_offers. These rows
-- exercise every comparison path without pretending to be live gaps:
--   1) open + probe pass + switch off            -> unknown_switch_or_policy_off
--   2) fixed + probe pass                        -> consistent
--   3) open + probe fail                         -> probe_fail_gap_open
--   4) fixed + probe fail                        -> gap_fixed_probe_fail (regression)
--   5) open + probe pass + no turn_offers        -> unknown_no_turn_offer (never backfill)
--   6) open + probe pass + tool not offered      -> unknown_tool_not_offered
--   7) open + probe pass + turn_offers confirm   -> probe_pass_gap_open
BEGIN;
INSERT OR REPLACE INTO capability_gaps(fingerprint,gap_type,capability,occurrences,first_seen,last_seen,evidence_json,proposed_action,owner,status,task_id,external_ref) VALUES
 ('fp-repo-open','data_stale_or_coverage','repo_visibility',3,1763000000000,1763100000000,'[{"source":"message","id":"fx-m-434","quote":"读一下自己仓库"}]','排查 repo_index 新鲜度与开关','工程师','open',NULL,'F5'),
 ('fp-xhs-fixed','tool_missing','xhs_note',2,1762900000000,1763000000000,'[{"source":"message","id":"fx-m-382","quote":"工作台UI修改指导"}]','read_web 抓正文或明确只拿到标题','工程师','fixed',NULL,NULL),
 ('fp-xhs-not-offered','tool_missing','xhs_note',1,1762850000000,1762900000000,'[{"source":"message","id":"fx-m-383","quote":"工作台UI修改指导"}]','read_web 抓正文或明确只拿到标题','工程师','open',NULL,NULL),
 ('fp-attach-open','tool_failed','attachment_send',1,1762800000000,1762800000000,'[{"source":"message","id":"fx-m-34","quote":"整理成 UTF-8 CSV 文件发回群里"}]','补发或贴文本，完成标准是 outbox sent','工程师','open',NULL,NULL),
 ('fp-attach-fixed','tool_failed','attachment_send',2,1762750000000,1762800000000,'[{"source":"message","id":"fx-m-34","quote":"整理成 UTF-8 CSV 文件发回群里"}]','补发或贴文本，完成标准是 outbox sent','工程师','fixed',NULL,NULL),
 ('fp-bili-open','tool_missing','bili_video',1,1762700000000,1762750000000,'[{"source":"message","id":"fx-m-375","quote":"BV1GN4p6pEEP"}]','无 CC 字幕时拉音轨转写','工程师','open',NULL,NULL),
 ('fp-bili-fixed','tool_missing','bili_video',2,1762700000000,1762750000000,'[{"source":"message","id":"fx-m-374","quote":"BV1GN4p6pEEP"}]','无 CC 字幕时拉音轨转写','工程师','fixed',NULL,NULL),
 ('fp-bili-pass-open','tool_missing','bili_shortlink',1,1762600000000,1762700000000,'[{"source":"message","id":"fx-m-417","quote":"b23.tv/F1DkQFC"}]','跟随 302 拿 BV 号','工程师','open',NULL,NULL);
INSERT OR REPLACE INTO turn_offers(turn_id,group_id,inbound_id,names,catalog_version,switches,runner_ok,release,created_at) VALUES
 ('t-repo','fx-group','fx-m-434','["repo_changes","repo_file","read_web"]','cat-v1','{"off:repo_tools":"on"}',1,'fixture',1763100000000),
 ('t-xhs','fx-group','fx-m-382','["read_web","create_file_task"]','cat-v1','{}',1,'fixture',1763000000000),
 ('t-xhs-not-offered','fx-group','fx-m-383','[]','cat-v1','{}',1,'fixture',1762900000000),
 ('t-attach','fx-group','fx-m-34','["read_web","create_file_task"]','cat-v1','{}',0,'fixture',1762800000000),
 ('t-bili-fixed','fx-group','fx-m-374','[]','cat-v1','{}',1,'fixture',1762750000000),
 ('t-bili-pass','fx-group','fx-m-417','[]','cat-v1','{}',1,'fixture',1762700000000);
COMMIT;
