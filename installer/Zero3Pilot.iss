#define MyAppName "Zero3 Pilot"
#define MyAppVersion "0.1.0"
#define MyAppPublisher "Zero3 Pilot"
#define MyAppExeName "zero3-pilot.exe"

[Setup]
AppId={{B92D72DD-3C5E-4F4C-9460-D9124D37D9C1}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={localappdata}\Programs\Zero3 Pilot
DefaultGroupName=Zero3 Pilot
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=..\dist
OutputBaseFilename=Zero3Pilot-Setup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\zero3-pilot.exe
SetupLogging=yes

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "快捷方式："; Flags: unchecked
Name: "weixinlogin"; Description: "安装后打开微信 ClawBot 连接向导"; GroupDescription: "可选连接："; Flags: unchecked

[Files]
Source: "..\target\release\zero3-pilot.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\target\release\zero3-pilot-node.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\target\release\zero3-pilot-weixin.exe"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\Zero3 Pilot"; Filename: "{app}\zero3-pilot.exe"; WorkingDir: "{app}"
Name: "{autoprograms}\Zero3 Pilot\连接微信 ClawBot"; Filename: "{cmd}"; Parameters: "/K ""{app}\zero3-pilot-weixin.exe"" login"; WorkingDir: "{app}"
Name: "{autoprograms}\Zero3 Pilot\微信 ClawBot 状态"; Filename: "{cmd}"; Parameters: "/K ""{app}\zero3-pilot-weixin.exe"" status"; WorkingDir: "{app}"
Name: "{autodesktop}\Zero3 Pilot"; Filename: "{app}\zero3-pilot.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\zero3-pilot.exe"; Description: "启动 Zero3 Pilot"; Flags: nowait postinstall skipifsilent
Filename: "{cmd}"; Parameters: "/K ""{app}\zero3-pilot-weixin.exe"" login"; Description: "连接微信 ClawBot"; Flags: postinstall skipifsilent; Tasks: weixinlogin

[Code]
var
  DependencyPage: TWizardPage;
  DependencyMemo: TNewMemo;

function CommandExists(const Name: String): Boolean;
var
  ResultCode: Integer;
begin
  Result := Exec(ExpandConstant('{cmd}'), '/C where "' + Name + '" >nul 2>nul', '', SW_HIDE,
    ewWaitUntilTerminated, ResultCode) and (ResultCode = 0);
end;

function Mark(const Present: Boolean): String;
begin
  if Present then
    Result := '✓ 已检测到'
  else
    Result := '○ 未检测到（可稍后安装/配置）';
end;

function DetectWebView2: Boolean;
begin
  Result := DirExists(ExpandConstant('{localappdata}\Microsoft\EdgeWebView\Application')) or
            DirExists(ExpandConstant('{pf32}\Microsoft\EdgeWebView\Application')) or
            FileExists(ExpandConstant('{pf32}\Microsoft\Edge\Application\msedge.exe')) or
            FileExists(ExpandConstant('{pf}\Microsoft\Edge\Application\msedge.exe'));
end;

function DetectChromeOrEdge: Boolean;
begin
  Result := CommandExists('chrome.exe') or CommandExists('msedge.exe') or
            FileExists(ExpandConstant('{pf}\Google\Chrome\Application\chrome.exe')) or
            FileExists(ExpandConstant('{pf32}\Google\Chrome\Application\chrome.exe')) or
            FileExists(ExpandConstant('{pf}\Microsoft\Edge\Application\msedge.exe')) or
            FileExists(ExpandConstant('{pf32}\Microsoft\Edge\Application\msedge.exe'));
end;

procedure RefreshDependencyMemo;
var
  Lines: String;
begin
  Lines := 'Zero3 Pilot 核心依赖检测' + #13#10 + #13#10;
  Lines := Lines + 'WebView2 / Edge Runtime     ' + Mark(DetectWebView2) + #13#10;
  Lines := Lines + 'Chrome / Edge 浏览器       ' + Mark(DetectChromeOrEdge) + #13#10;
  Lines := Lines + 'Codex CLI                  ' + Mark(CommandExists('codex.exe') or CommandExists('codex')) + #13#10;
  Lines := Lines + 'Claude CLI                 ' + Mark(CommandExists('claude.exe') or CommandExists('claude')) + #13#10;
  Lines := Lines + 'Hermes CLI                 ' + Mark(CommandExists('hermes.exe') or CommandExists('hermes')) + #13#10;
  Lines := Lines + 'Open Computer Use          ' + Mark(CommandExists('open-computer-use.cmd') or CommandExists('open-computer-use')) + #13#10;
  Lines := Lines + #13#10 +
    '说明：WebView2 用于桌面 UI；浏览器用于 CDP 自动化。Codex / Claude / Hermes 可按需安装，' +
    '至少安装你计划使用的 Agent。Open Computer Use 用于 Windows UI Automation。' + #13#10 + #13#10 +
    '微信 ClawBot 不要求安装 OpenClaw：Zero3 Pilot 使用腾讯官方 iLink HTTP/JSON 协议直接连接。';
  DependencyMemo.Text := Lines;
end;

procedure InitializeWizard;
begin
  DependencyPage := CreateCustomPage(wpSelectTasks, '运行环境检查',
    '确认本机依赖。缺失的可选组件不会阻止安装。');
  DependencyMemo := TNewMemo.Create(DependencyPage);
  DependencyMemo.Parent := DependencyPage.Surface;
  DependencyMemo.Left := 0;
  DependencyMemo.Top := 0;
  DependencyMemo.Width := DependencyPage.SurfaceWidth;
  DependencyMemo.Height := DependencyPage.SurfaceHeight;
  DependencyMemo.ReadOnly := True;
  DependencyMemo.ScrollBars := ssVertical;
  RefreshDependencyMemo;
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if CurPageID = DependencyPage.ID then
    RefreshDependencyMemo;
end;
