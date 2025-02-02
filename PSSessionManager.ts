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

  // We'll store lines from stdout here
  private outputBuffer: string[] = [];
  // A regex to detect the typical PowerShell prompt line
  private promptRegex = /> $|PS .*?> $/;

  constructor(options: PSSessionOptions) {
    this.host = options.host;
    this.username = options.username;
    this.password = options.password;
  }

  /**
   * Spawns PowerShell and enters a remote session using the credentials.
   * Also prints each line to the Node console for a live view.
   */
  public async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.username || !this.password) {
        return reject(new Error('Username or password not provided.'));
      }

      // Spawn an interactive PowerShell process
      this.psProcess = spawn('powershell.exe', ['-NoExit', '-Command', '-'], {
        stdio: 'pipe',
      });

      if (!this.psProcess || !this.psProcess.stdout) {
        return reject(new Error('Failed to spawn PowerShell process.'));
      }

      // Setup reading from stdout line-by-line
      const rl = readline.createInterface({ input: this.psProcess.stdout });
      rl.on('line', (line) => {
        // 1. Print each line so you can "see" the session live in the Node console.
        console.log(line);

        // 2. Keep storing the line for internal parsing
        this.outputBuffer.push(line);
      });

      // Capture errors from stderr and print them as well
      if (this.psProcess.stderr) {
        this.psProcess.stderr.on('data', (data) => {
          const msg = data.toString();
          console.error('PowerShell ERR:', msg);
          this.outputBuffer.push(`ERROR: ${msg}`);
        });
      }

      // Handle process exit
      this.psProcess.on('exit', (code) => {
        this.psProcess = null;
        console.log(`PowerShell exited (code: ${code})`);
      });

      // Build the commands to create a PSCredential and enter the session
      const psCommands = `
$pass = ConvertTo-SecureString '${this.escapeForPS(this.password)}' -AsPlainText -Force
$cred = New-Object System.Management.Automation.PSCredential ('${this.escapeForPS(this.username)}', $pass)
Enter-PSSession -ComputerName '${this.escapeForPS(this.host)}' -Credential $cred
`;

      // Give PowerShell a second to initialize, then send our commands
      setTimeout(() => {
        if (!this.psProcess || !this.psProcess.stdin) return;
        this.psProcess.stdin.write(psCommands + '\n');

        // Wait briefly for the remote session prompt to appear
        setTimeout(() => {
          resolve();
        }, 1500);
      }, 1000);
    });
  }

  /**
   * Runs a command in the remote session.
   * We'll parse the output up until the next prompt.
   */
  public async runCommand(command: string): Promise<string> {
    if (!this.psProcess || !this.psProcess.stdin) {
      throw new Error('PowerShell process not started. Call connect() first.');
    }

    return new Promise((resolve) => {
      const initialLength = this.outputBuffer.length;

      // Write the command
      this.psProcess.stdin.write(`${command}\n`);

      // Poll until we detect the next prompt line
      const checkInterval = setInterval(() => {
        const newOutput = this.outputBuffer.slice(initialLength);

        if (newOutput.length > 0 && this.promptRegex.test(newOutput[newOutput.length - 1])) {
          clearInterval(checkInterval);

          // The raw lines from the command are everything except the last line (the new prompt).
          // Also skip the echoed command itself if present.
          const rawResult = newOutput.slice(0, -1).join('\n');
          resolve(rawResult);
        }
      }, 300);
    });
  }

  /**
   * Exits the remote session and closes PowerShell.
   */
  public async disconnect(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.psProcess || !this.psProcess.stdin) {
        resolve();
        return;
      }

      // Leave the remote session
      this.psProcess.stdin.write('Exit-PSSession\n');
      // Exit PowerShell
      this.psProcess.stdin.write('exit\n');

      // Listen for the process to actually close
      this.psProcess.on('exit', () => {
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
