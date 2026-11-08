; Inno Setup script for the Talon companion desktop app (Windows).
;
; Packages the `flutter build windows --release` output into a single
; double-click Setup.exe — the Windows counterpart of the macOS DMG. Built in
; CI (see .github/workflows/companion.yml); not meant to be run by hand.
;
; Two values are passed on the ISCC command line so nothing is hand-bumped:
;   /DAppVersion=<x.y.z>   the Talon release version (defaults to 0.0.0)
;   /DSourceDir=<path>     the Release folder that holds talon_companion.exe
; The launcher icon is the committed app .ico; windows/ itself is gitignored
; and regenerated per build, so the installer never depends on it.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef SourceDir
  #define SourceDir "..\..\build\windows\x64\runner\Release"
#endif

#define AppName "Talon"
#define AppExeName "talon_companion.exe"
#define AppPublisher "The Falconry"
#define AppURL "https://github.com/thefalconry/talon"

[Setup]
; A stable, hard-coded GUID keeps upgrades in place (do not regenerate).
AppId={{6F3B9A2E-4C1D-4E8A-9B7F-2A5C8D1E6F04}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppURL}
AppSupportURL={#AppURL}
AppUpdatesURL={#AppURL}/releases
DefaultDirName={autopf}\Talon
DefaultGroupName=Talon
DisableProgramGroupPage=yes
; Per-user install by default — no admin/UAC prompt required.
PrivilegesRequiredOverridesAllowed=dialog commandline
PrivilegesRequired=lowest
OutputDir=.
OutputBaseFilename=talon-companion-windows-setup
SetupIconFile=..\..\assets\icon\talon_icon.ico
UninstallDisplayIcon={app}\{#AppExeName}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesInstallIn64BitMode=x64compatible
ArchitecturesAllowed=x64compatible

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
; The whole Release folder: talon_companion.exe, its DLLs, flutter_assets, etc.
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{group}\Talon"; Filename: "{app}\{#AppExeName}"
Name: "{group}\{cm:UninstallProgram,Talon}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\Talon"; Filename: "{app}\{#AppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExeName}"; Description: "{cm:LaunchProgram,Talon}"; Flags: nowait postinstall skipifsilent
