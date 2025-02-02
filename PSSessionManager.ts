import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as readline from 'readline';

export interface PSSessionOptions {
  host: string;
  username: string;
  password: string;
}

export class PSSessionManager {
  private host: string;
  private username: string;
  private password: string;
  private psProcess: ChildProcessWithoutNullStreams | null = null;
  private outputBuffer: string[] = [];
  private sessionVariable = '$session';
  private CONNECT_MARKER = 'SESSION_READY';
  private COMMAND_MARKER = 'COMMAND_DONE';
  private DISCONNECT_MARKER = 'SESSION_REMOVED';

  constructor(options: PSSessionOptions) {
    this.host = options.host;
    this.username = options.username;
    this.password = options.password;
  }

  public async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.psProcess = spawn('powershell.exe', ['-NoExit', '-Command', '-'], { stdio: 'pipe' });
      if (!this.psProcess || !this.psProcess.stdout) {
        return reject(new Error('Failed to spawn PowerShell process.'));
      }

      const rl = readline.createInterface({ input: this.psProcess.stdout });
      rl.on('line', (line) => {
        // Debug print
        console.log('[PowerShell:stdout]', line);
        this.outputBuffer.push(line);
      });

      if (this.psProcess.stderr) {
        this.psProcess.stderr.on('data', (data) => {
          const msg = data.toString();
          console.error('[PowerShell:stderr]', msg);
          this.outputBuffer.push(`ERROR: ${msg}`);
        });
      }

      this.psProcess.on('exit', () => {
        this.psProcess = null;
      });

      setTimeout(() => {
        if (!this.psProcess || !this.psProcess.stdin) {
          return reject(new Error('PowerShell process not available.'));
        }

        const script = `
$pass = ConvertTo-SecureString '${this.escapeForPS(this.password)}' -AsPlainText -Force
$cred = New-Object System.Management.Automation.PSCredential ('${this.escapeForPS(this.username)}', $pass)
${this.sessionVariable} = New-PSSession -ComputerName '${this.escapeForPS(this.host)}' -Credential $cred
Write-Host '${this.CONNECT_MARKER}'
`;
        console.log('[connect] Creating remote session...');
        this.psProcess.stdin.write(script + '\n');

        const checkInterval = setInterval(() => {
          if (this.outputBuffer.some((l) => l.includes(this.CONNECT_MARKER))) {
            clearInterval(checkInterval);
            resolve();
          }
        }, 300);
      }, 500);
    });
  }

  public async runCommand(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.psProcess || !this.psProcess.stdin) {
        return reject(new Error('PowerShell process not started.'));
      }

      const initialLength = this.outputBuffer.length;

      // 1) Print the command itself
      // 2) Pipe command output to Out-String
      // 3) Print COMMAND_DONE marker
      const script = `
Write-Host "COMMAND: ${command}"
Invoke-Command -Session ${this.sessionVariable} -ScriptBlock { ${command} | Out-String } | Write-Host
Write-Host '${this.COMMAND_MARKER}'
`;
      console.log('[runCommand] Sending script:\n', script);
      this.psProcess.stdin.write(script + '\n');

      const checkInterval = setInterval(() => {
        const newOutput = this.outputBuffer.slice(initialLength);
        console.log('[runCommand:poll] newOutput =', newOutput);

        // If any line has COMMAND_MARKER, we collect everything including that line
        const idx = newOutput.findIndex((l) => l.includes(this.COMMAND_MARKER));
        if (idx !== -1) {
          clearInterval(checkInterval);

          // Everything up to (and including) idx
          const linesUntilMarker: string[] = [];
          for (let i = 0; i <= idx; i++) {
            linesUntilMarker.push(newOutput[i]);
          }
          // This now contains:
          //    "COMMAND: <yourCommand>"
          //    <output lines>
          //    "COMMAND_DONE"

          resolve(linesUntilMarker.join('\n'));
        }
      }, 300);
    });
  }

  public async disconnect(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.psProcess || !this.psProcess.stdin) {
        resolve();
        return;
      }

      const initialLength = this.outputBuffer.length;
      const script = `
Remove-PSSession -Session ${this.sessionVariable}
Write-Host '${this.DISCONNECT_MARKER}'
exit
`;
      this.psProcess.stdin.write(script + '\n');

      const checkInterval = setInterval(() => {
        const newOutput = this.outputBuffer.slice(initialLength);
        if (newOutput.some((l) => l.includes(this.DISCONNECT_MARKER))) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 300);
    });
  }

  private escapeForPS(str: string): string {
    return str.replace(/'/g, "''");
  }
}
