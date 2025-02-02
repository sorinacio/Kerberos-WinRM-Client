import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as readline from 'readline';

export interface PSSessionOptions {
  host: string;      // Remote machine (name or IP)
  username: string;  // Domain\Username format
  password: string;  // Plain text password (see security notes)
}

export class PSSessionManager {
  private host: string;
  private username: string;
  private password: string;
  private psProcess: ChildProcessWithoutNullStreams | null = null;

  private outputBuffer: string[] = [];
  private promptRegex = /> $|PS .*?> $/;

  constructor(options: PSSessionOptions) {
    this.host = options.host;
    this.username = options.username;
    this.password = options.password;

    console.log(`[constructor] Initialized PSSessionManager for host "${this.host}" with user "${this.username}".`);
  }

  /**
   * Spawns PowerShell and enters a remote session using the credentials.
   */
  public async connect(): Promise<void> {
    console.log('[connect] Starting connection...');

    return new Promise((resolve, reject) => {
      if (!this.username || !this.password) {
        console.error('[connect] Missing username or password.');
        return reject(new Error('Username or password not provided.'));
      }

      console.log('[connect] Spawning PowerShell process...');
      this.psProcess = spawn('powershell.exe', ['-NoExit', '-Command', '-'], {
        stdio: 'pipe',
      });

      if (!this.psProcess || !this.psProcess.stdout) {
        console.error('[connect] Failed to spawn PowerShell process.');
        return reject(new Error('Failed to spawn PowerShell process.'));
      }

      // Read PowerShell output live
      const rl = readline.createInterface({ input: this.psProcess.stdout });
      rl.on('line', (line) => {
        console.log(`[PowerShell] ${line}`);
        this.outputBuffer.push(line);
      });

      // Capture errors
      if (this.psProcess.stderr) {
        this.psProcess.stderr.on('data', (data) => {
          const msg = data.toString();
          console.error(`[PowerShell ERROR] ${msg}`);
          this.outputBuffer.push(`ERROR: ${msg}`);
        });
      }

      // Handle process exit
      this.psProcess.on('exit', (code) => {
        console.log(`[connect] PowerShell exited with code: ${code}`);
        this.psProcess = null;
      });

      // PowerShell credential setup commands
      const psCommands = `
$pass = ConvertTo-SecureString '${this.escapeForPS(this.password)}' -AsPlainText -Force
$cred = New-Object System.Management.Automation.PSCredential ('${this.escapeForPS(this.username)}', $pass)
Enter-PSSession -ComputerName '${this.escapeForPS(this.host)}' -Credential $cred
`;

      console.log('[connect] Waiting 1 second for PowerShell to initialize...');
      setTimeout(() => {
        if (!this.psProcess || !this.psProcess.stdin) {
          console.error('[connect] PowerShell process or stdin not available.');
          return reject(new Error('PowerShell process is not available.'));
        }
        console.log('[connect] Sending PSCredential creation and Enter-PSSession commands...');
        this.psProcess.stdin.write(psCommands + '\n');

        console.log('[connect] Waiting 1.5 seconds for remote session prompt...');
        setTimeout(() => {
          console.log('[connect] Connection setup should be complete.');
          resolve();
        }, 1500);
      }, 1000);
    });
  }

  /**
   * Runs a command in the remote session.
   */
  public async runCommand(command: string): Promise<string> {
    console.log(`[runCommand] Sending command: "${command}"`);

    if (!this.psProcess || !this.psProcess.stdin) {
      console.error('[runCommand] PowerShell process not started. Call connect() first.');
      throw new Error('PowerShell process not started.');
    }

    return new Promise((resolve) => {
      const initialLength = this.outputBuffer.length;

      this.psProcess.stdin.write(`${command}\n`);

      // Poll for new output
      const checkInterval = setInterval(() => {
        const newOutput = this.outputBuffer.slice(initialLength);

        if (newOutput.length > 0 && this.promptRegex.test(newOutput[newOutput.length - 1])) {
          clearInterval(checkInterval);

          const rawResult = newOutput.slice(0, -1).join('\n');
          console.log(`[runCommand] Command output:\n${rawResult}\n`);
          resolve(rawResult);
        }
      }, 300);
    });
  }

  /**
   * Exits the remote session and closes PowerShell.
   */
  public async disconnect(): Promise<void> {
    console.log('[disconnect] Closing session...');
    return new Promise((resolve) => {
      if (!this.psProcess || !this.psProcess.stdin) {
        console.log('[disconnect] No active PowerShell process.');
        resolve();
        return;
      }

      console.log('[disconnect] Sending Exit-PSSession...');
      this.psProcess.stdin.write('Exit-PSSession\n');
      console.log('[disconnect] Sending exit...');
      this.psProcess.stdin.write('exit\n');

      this.psProcess.on('exit', () => {
        console.log('[disconnect] PowerShell process exited.');
        this.psProcess = null;
        resolve();
      });
    });
  }

  /**
   * Escape single quotes for inline PowerShell strings.
   */
  private escapeForPS(str: string): string {
    return str.replace(/'/g, "''");
  }
}
