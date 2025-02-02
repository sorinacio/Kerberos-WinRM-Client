import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as readline from 'readline';

export interface PSSessionOptions {
  host: string;      // Remote machine (DNS name or IP)
  username: string;  // Domain\Username format
  password: string;  // Plain-text password (see security concerns)
}

/**
 * A class to manage a local PowerShell process that enters a remote session.
 * - Spawns PowerShell
 * - Builds PSCredential
 * - Calls Enter-PSSession
 * - Executes commands & captures output
 * - Exits the session & closes PowerShell
 */
export class PSSessionManager {
  private host: string;
  private username: string;
  private password: string;
  private psProcess: ChildProcessWithoutNullStreams | null = null;

  // We’ll store all lines read from stdout in this buffer.
  private outputBuffer: string[] = [];

  // A regex to detect the typical PowerShell prompt line (ends in '> ' or 'PS ...> ').
  private promptRegex = /> $|PS .*?> $/;

  constructor(options: PSSessionOptions) {
    this.host = options.host;
    this.username = options.username;
    this.password = options.password;

    console.log(`[constructor] Initialized PSSessionManager for host "${this.host}" with user "${this.username}".`);
  }

  /**
   * Spawns a local PowerShell process and enters a remote session using the provided credentials.
   * Also prints each line so you can watch it live in the Node console.
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
        console.error('[connect] Failed to spawn PowerShell process or get stdout.');
        return reject(new Error('Failed to spawn PowerShell process.'));
      }

      // Setup reading from stdout line-by-line
      const rl = readline.createInterface({ input: this.psProcess.stdout });
      rl.on('line', (line) => {
        // Print each line for a live console-like output
        console.log(`[connect:stdout] ${line}`);
        // Store for internal parsing
        this.outputBuffer.push(line);
      });

      // Capture errors from stderr
      if (this.psProcess.stderr) {
        this.psProcess.stderr.on('data', (data) => {
          const msg = data.toString();
          console.error(`[connect:stderr] ${msg}`);
          this.outputBuffer.push(`ERROR: ${msg}`);
        });
      }

      // Handle process exit
      this.psProcess.on('exit', (code) => {
        console.log(`[connect] PowerShell process exited with code: ${code}`);
        this.psProcess = null;
      });

      // Build the commands to create a PSCredential and enter the session
      const psCommands = `
$pass = ConvertTo-SecureString '${this.escapeForPS(this.password)}' -AsPlainText -Force
$cred = New-Object System.Management.Automation.PSCredential ('${this.escapeForPS(this.username)}', $pass)
Enter-PSSession -ComputerName '${this.escapeForPS(this.host)}' -Credential $cred
`;

      console.log('[connect] Waiting 1 second for PowerShell to initialize...');
      setTimeout(() => {
        if (!this.psProcess || !this.psProcess.stdin) {
          console.error('[connect] PowerShell process or stdin not available after spawn.');
          return;
        }

        console.log('[connect] Sending PSCredential creation + Enter-PSSession commands...');
        this.psProcess.stdin.write(psCommands + '\n');

        // Wait briefly for the remote session prompt to appear
        console.log('[connect] Waiting 1.5 seconds for the remote session prompt...');
        setTimeout(() => {
          console.log('[connect] Connection setup should be complete.');
          resolve();
        }, 1500);
      }, 1000);
    });
  }

  /**
   * Runs a command in the remote session.
   * We parse the output until the next prompt is detected.
   */
  public async runCommand(command: string): Promise<string> {
    console.log(`[runCommand] Sending command: "${command}"`);

    // Check if the PowerShell process is valid before writing to stdin
    if (!this.psProcess || !this.psProcess.stdin) {
      const errorMsg = '[runCommand] PowerShell process not started or stdin unavailable. Call connect() first.';
      console.error(errorMsg);
      throw new Error(errorMsg);
    }

    return new Promise((resolve) => {
      const initialLength = this.outputBuffer.length;

      // Write the command
      this.psProcess.stdin.write(`${command}\n`);

      // Poll until we detect the next prompt line
      const checkInterval = setInterval(() => {
        // We only look at the lines added since we wrote the command
        const newOutput = this.outputBuffer.slice(initialLength);

        // Debugging: Show newly captured lines if needed
        // console.log('[runCommand:debug] Checking new lines:', newOutput);

        // If we see a line matching the prompt, we assume the command has finished
        if (newOutput.length > 0 && this.promptRegex.test(newOutput[newOutput.length - 1])) {
          clearInterval(checkInterval);

          // The raw lines for this command’s output: everything except the last line (the prompt).
          // Also often the first line might echo the command itself, depending on PowerShell version.
          const rawResult = newOutput.slice(0, -1).join('\n');

          console.log(`[runCommand] Command completed. Output:\n${rawResult}\n`);
          resolve(rawResult);
        }
      }, 300);
    });
  }

  /**
   * Exits the remote session and closes the local PowerShell process.
   */
  public async disconnect(): Promise<void> {
    console.log('[disconnect] Closing remote session and terminating PowerShell...');

    return new Promise((resolve) => {
      if (!this.psProcess || !this.psProcess.stdin) {
        console.log('[disconnect] No active PowerShell process to close.');
        resolve();
        return;
      }

      // Leave the remote session
      console.log('[disconnect] Sending Exit-PSSession...');
      this.psProcess.stdin.write('Exit-PSSession\n');

      // Then exit PowerShell entirely
      console.log('[disconnect] Sending exit...');
      this.psProcess.stdin.write('exit\n');

      // Listen for the process to actually close
      this.psProcess.on('exit', () => {
        console.log('[disconnect] PowerShell process has exited.');
        this.psProcess = null;
        resolve();
      });
    });
  }

  /**
   * Utility: Escapes single quotes so they don't break inline PowerShell strings.
   */
  private escapeForPS(str: string): string {
    return str.replace(/'/g, "''");
  }
}
