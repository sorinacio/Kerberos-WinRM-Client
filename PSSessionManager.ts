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
    console.log(`[constructor] host="${this.host}", user="${this.username}"`);
  }

  public async connect(): Promise<void> {
    console.log('[connect] Spawning PowerShell process...');
    return new Promise((resolve, reject) => {
      this.psProcess = spawn('powershell.exe', ['-NoExit', '-Command', '-'], { stdio: 'pipe' });
      if (!this.psProcess || !this.psProcess.stdout) {
        console.error('[connect] Failed to spawn PowerShell process.');
        return reject(new Error('Failed to spawn PowerShell process.'));
      }

      const rl = readline.createInterface({ input: this.psProcess.stdout });
      rl.on('line', (line) => {
        console.log(`[PowerShell:stdout] ${line}`);
        this.outputBuffer.push(line);
      });

      if (this.psProcess.stderr) {
        this.psProcess.stderr.on('data', (data) => {
          const msg = data.toString();
          console.error(`[PowerShell:stderr] ${msg}`);
          this.outputBuffer.push(`ERROR: ${msg}`);
        });
      }

      this.psProcess.on('exit', (code) => {
        console.log(`[connect] PowerShell exited with code ${code}`);
        this.psProcess = null;
      });

      setTimeout(() => {
        if (!this.psProcess || !this.psProcess.stdin) {
          console.error('[connect] PowerShell stdin not available.');
          return reject(new Error('PowerShell process not available.'));
        }

        const script = `
$pass = ConvertTo-SecureString '${this.escapeForPS(this.password)}' -AsPlainText -Force
$cred = New-Object System.Management.Automation.PSCredential ('${this.escapeForPS(this.username)}', $pass)
${this.sessionVariable} = New-PSSession -ComputerName '${this.escapeForPS(this.host)}' -Credential $cred
Write-Host '${this.CONNECT_MARKER}'
`;

        console.log('[connect] Sending script to create session...');
        console.log(`[connect:script]\n${script}`);

        this.psProcess.stdin.write(script + '\n');

        const checkInterval = setInterval(() => {
          console.log('[connect:poll] Checking for CONNECT_MARKER...');
          if (this.outputBuffer.some((l) => l.includes(this.CONNECT_MARKER))) {
            console.log('[connect:poll] Found CONNECT_MARKER.');
            clearInterval(checkInterval);
            resolve();
          }
        }, 300);
      }, 500);
    });
  }

  public async runCommand(command: string): Promise<string> {
    console.log(`[runCommand] About to run command: ${command}`);
    return new Promise((resolve, reject) => {
      if (!this.psProcess || !this.psProcess.stdin) {
        console.error('[runCommand] PowerShell process not started.');
        return reject(new Error('PowerShell process not started.'));
      }

      const initialLength = this.outputBuffer.length;

      const script = `
Invoke-Command -Session ${this.sessionVariable} -ScriptBlock { ${command} | Out-String } | Write-Host
Write-Host '${this.COMMAND_MARKER}'
`;

      console.log('[runCommand] Sending script:');
      console.log(`[runCommand:script]\n${script}`);

      this.psProcess.stdin.write(script + '\n');

      const checkInterval = setInterval(() => {
        const newOutput = this.outputBuffer.slice(initialLength);
        console.log('[runCommand:poll] newOutput:\n', JSON.stringify(newOutput, null, 2));

        if (newOutput.some((l) => l.includes(this.COMMAND_MARKER))) {
          console.log('[runCommand:poll] Found COMMAND_MARKER.');
          clearInterval(checkInterval);
          const linesUntilMarker: string[] = [];
          for (const line of newOutput) {
            if (line.includes(this.COMMAND_MARKER)) {
              break;
            }
            linesUntilMarker.push(line);
          }
          console.log('[runCommand] Lines until marker:\n', JSON.stringify(linesUntilMarker, null, 2));
          resolve(linesUntilMarker.join('\n'));
        }
      }, 300);
    });
  }

  public async disconnect(): Promise<void> {
    console.log('[disconnect] Closing session.');
    return new Promise((resolve) => {
      if (!this.psProcess || !this.psProcess.stdin) {
        console.log('[disconnect] No active PowerShell process.');
        resolve();
        return;
      }

      const script = `
Remove-PSSession -Session ${this.sessionVariable}
Write-Host '${this.DISCONNECT_MARKER}'
exit
`;

      const initialLength = this.outputBuffer.length;
      console.log('[disconnect] Sending remove session + exit...');
      console.log(`[disconnect:script]\n${script}`);

      this.psProcess.stdin.write(script + '\n');

      const checkInterval = setInterval(() => {
        const newOutput = this.outputBuffer.slice(initialLength);
        console.log('[disconnect:poll] newOutput:\n', JSON.stringify(newOutput, null, 2));

        if (newOutput.some((l) => l.includes(this.DISCONNECT_MARKER))) {
          console.log('[disconnect:poll] Found DISCONNECT_MARKER.');
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
