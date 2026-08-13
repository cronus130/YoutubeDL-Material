import { Component, OnInit, OnDestroy } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';
import { PostsService, YtdlpStatus } from 'app/posts.services';

@Component({
  selector: 'app-ytdlp-status',
  templateUrl: './ytdlp-status.component.html',
  styleUrls: ['./ytdlp-status.component.scss']
})
export class YtdlpStatusComponent implements OnInit, OnDestroy {

  status: YtdlpStatus = null;
  checking = false;

  // While a check is in flight the sidecar is polled so the version and
  // timestamps update on their own, without the user reloading the page.
  private poll_timer = null;
  private poll_attempts = 0;
  private readonly POLL_INTERVAL_MS = 3000;
  private readonly MAX_POLL_ATTEMPTS = 20;

  constructor(public postsService: PostsService, private snackBar: MatSnackBar) { }

  ngOnInit(): void {
    if (this.postsService.initialized) {
      this.getStatus();
    } else {
      this.postsService.service_initialized.subscribe(init => {
        if (init) this.getStatus();
      });
    }
  }

  ngOnDestroy(): void {
    this.stopPolling();
  }

  getStatus(): void {
    this.postsService.getYtdlpStatus().subscribe(res => {
      this.status = res;
    }, err => {
      // An older backend without the endpoint should leave the widget hidden
      // rather than throwing errors into the console on every page load.
      this.status = null;
    });
  }

  checkNow(): void {
    if (this.checking) return;
    this.checking = true;
    const last_check_before = this.status ? this.status.last_check : null;

    this.postsService.ytdlpCheckNow().subscribe(res => {
      if (!res.success) {
        this.checking = false;
        this.snackBar.open('Could not request an update check.', 'Dismiss');
        return;
      }
      if (!res.sidecar_detected) {
        this.checking = false;
        this.snackBar.open('No updater sidecar is running, so nothing will act on the request.', 'Dismiss');
        return;
      }
      this.startPolling(last_check_before);
    }, err => {
      this.checking = false;
      this.snackBar.open('Could not request an update check.', 'Dismiss');
    });
  }

  // The sidecar picks the request up within seconds, but the run itself takes a
  // little longer. Watching last_check change is how we know it finished.
  private startPolling(last_check_before: string): void {
    this.stopPolling();
    this.poll_attempts = 0;
    this.poll_timer = setInterval(() => {
      this.poll_attempts++;
      this.postsService.getYtdlpStatus().subscribe(res => {
        const previous_version = this.status ? this.status.version : null;
        this.status = res;
        if (res.last_check && res.last_check !== last_check_before) {
          this.stopPolling();
          this.checking = false;
          if (res.version && res.version !== previous_version) {
            this.snackBar.open(`Updated to ${res.version}.`, 'Dismiss', {duration: 5000});
          } else if (res.last_result === 'held') {
            this.snackBar.open(`Held on ${res.held_version} after a rollback - release the hold to resume updates.`, 'Dismiss');
          } else if (res.last_result === 'failed') {
            this.snackBar.open('The update check failed. See the updater logs.', 'Dismiss');
          } else {
            this.snackBar.open('Already up to date.', 'Dismiss', {duration: 4000});
          }
        } else if (this.poll_attempts >= this.MAX_POLL_ATTEMPTS) {
          this.stopPolling();
          this.checking = false;
          this.snackBar.open('The updater did not report back in time. Check the sidecar logs.', 'Dismiss');
        }
      }, err => {
        this.stopPolling();
        this.checking = false;
      });
    }, this.POLL_INTERVAL_MS);
  }

  private stopPolling(): void {
    if (this.poll_timer) {
      clearInterval(this.poll_timer);
      this.poll_timer = null;
    }
  }

  // "3 hours ago" style text. Kept local rather than pulling in a pipe, since
  // this is the only place in the app that needs it.
  relativeTime(timestamp: string): string {
    if (!timestamp) return 'never';
    const then = new Date(timestamp).getTime();
    if (isNaN(then)) return 'unknown';

    const seconds = Math.floor((Date.now() - then) / 1000);
    if (seconds < 0) return 'just now';
    if (seconds < 60) return 'just now';

    const units: [number, string][] = [
      [60, 'minute'],
      [3600, 'hour'],
      [86400, 'day'],
      [604800, 'week']
    ];
    let best: [number, string] = units[0];
    for (const unit of units) {
      if (seconds >= unit[0]) best = unit;
    }
    const value = Math.floor(seconds / best[0]);
    return `${value} ${best[1]}${value === 1 ? '' : 's'} ago`;
  }

  absoluteTime(timestamp: string): string {
    if (!timestamp) return '';
    const date = new Date(timestamp);
    return isNaN(date.getTime()) ? '' : date.toLocaleString();
  }
}
