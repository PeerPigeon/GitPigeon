#define SourceBinary GetEnv("GITPIGEON_BINARY")
#define OutputDirectory GetEnv("GITPIGEON_OUTPUT_DIR")
#define GitPigeonVersion GetEnv("GITPIGEON_VERSION")

[Setup]
AppId={{D2E03161-B7F0-4C90-A658-A7682916197D}
AppName=GitPigeon
AppVersion={#GitPigeonVersion}
AppPublisher=PeerPigeon
AppPublisherURL=https://gitpigeon.dev/
DefaultDirName={localappdata}\Programs\GitPigeon
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#OutputDirectory}
OutputBaseFilename=GitPigeon-windows-x64-Setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName=GitPigeon

[Files]
Source: "{#SourceBinary}"; DestDir: "{app}"; DestName: "git-pigeon.exe"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\GitPigeon"; Filename: "{app}\git-pigeon.exe"; Parameters: "install --enroll"

[Registry]
Root: HKCU; Subkey: "Software\Classes\gitpigeon"; ValueType: string; ValueName: ""; ValueData: "URL:GitPigeon Protocol"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\gitpigeon"; ValueType: string; ValueName: "URL Protocol"; ValueData: ""
Root: HKCU; Subkey: "Software\Classes\gitpigeon\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\git-pigeon.exe"" protocol ""%1"""

[Run]
Filename: "{app}\git-pigeon.exe"; Parameters: "install"; Description: "Approve this device with GitPigeon"; Flags: nowait postinstall skipifsilent
