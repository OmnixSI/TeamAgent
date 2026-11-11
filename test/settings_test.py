import unittest,tempfile,pathlib,json,os
from unittest.mock import patch
from runner.settings import api_key,settings

class SharedSettingsTests(unittest.TestCase):
    def test_common_team_key_does_not_depend_on_personal_dsh_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            home=pathlib.Path(directory);(home/".inkboard-team").mkdir()
            (home/".inkboard-team/worker-secrets.json").write_text(json.dumps({"DEEPSEEK_API_KEY":"team-test-key"}))
            with patch.object(pathlib.Path,"home",return_value=home),patch.dict(os.environ,{},clear=True):
                self.assertEqual(api_key(),"team-test-key")
                with patch.dict(os.environ,{"DEEPSEEK_API_KEY":"explicit-deployment-key"}):self.assertEqual(api_key(),"explicit-deployment-key")
    def test_installed_settings_override_the_repository_defaults(self):
        with tempfile.TemporaryDirectory() as directory:
            home=pathlib.Path(directory);(home/".inkboard-team").mkdir()
            with patch.object(pathlib.Path,"home",return_value=home):
                expected=json.loads((pathlib.Path(__file__).parents[1]/"config/team.json").read_text())["model"]["name"]
                self.assertEqual(settings()["model"]["name"],expected)
                (home/".inkboard-team/agent-settings.json").write_text(json.dumps({"execution":{"repair_rounds":1}}))
                with patch.dict(os.environ,{"TEAM_AGENT_SETTINGS":str(home/".inkboard-team/agent-settings.json")}):self.assertEqual(settings()["execution"]["repair_rounds"],1)
