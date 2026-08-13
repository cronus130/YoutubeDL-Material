import { Component, OnInit, OnDestroy, ViewChild, Input, EventEmitter, HostListener } from '@angular/core';
import { PostsService } from 'app/posts.services';
import { trigger, transition, animateChild, stagger, query, style, animate } from '@angular/animations';
import { Router } from '@angular/router';
import { MatPaginator } from '@angular/material/paginator';
import { MatTableDataSource } from '@angular/material/table';
import { MatDialog } from '@angular/material/dialog';
import { ConfirmDialogComponent } from 'app/dialogs/confirm-dialog/confirm-dialog.component';
import { MatSort } from '@angular/material/sort';
import { Clipboard } from '@angular/cdk/clipboard';
import { Download } from 'api-types';

@Component({
  selector: 'app-downloads',
  templateUrl: './downloads.component.html',
  styleUrls: ['./downloads.component.scss']
})
export class DownloadsComponent implements OnInit, OnDestroy {

  @Input() uids: string[] = null;

  downloads_check_interval = 1000;
  downloads = [];
  finished_downloads = [];
  interval_id = null;

  keys = Object.keys;

  valid_sessions_length = 0;

  paused_download_exists = false;
  running_download_exists = false;

  STEP_INDEX_TO_LABEL = {
      0: $localize`Creating download`,
      1: $localize`Getting info`,
      2: $localize`Downloading file`,
      3: $localize`Complete`
  }

  actionsFlex = 2;
  minimizeButtons = false;
  displayedColumnsBig: string[] = ['timestamp_start', 'title', 'sub_name', 'percent_complete', 'actions'];
  displayedColumnsSmall: string[] = ['title', 'percent_complete', 'actions'];
  displayedColumns: string[] = this.displayedColumnsBig;
  dataSource = null; // new MatTableDataSource<Download>();

  // The purpose of this is to reduce code reuse for displaying these actions as icons or in a menu
  downloadActions: DownloadAction[] = [
    {
      tooltip: $localize`Watch content`,
      action: (download: Download) => this.watchContent(download),
      show: (download: Download) => download.finished && !download.error,
      icon: 'smart_display'
    },
    {
      tooltip: $localize`Show error`,
      action: (download: Download) => this.showError(download),
      show: (download: Download) => download.finished && !!download.error,
      icon: 'warning'
    },
    {
      // Raised by the site-detection fallback: it needs a decision before the
      // download can continue. Shown ahead of the pause/resume actions because
      // nothing else will move this download along.
      tooltip: $localize`Review and confirm`,
      action: (download: Download) => this.reviewPendingDownload(download),
      show: (download: Download) => !!download['pending_confirmation'],
      icon: 'rule'
    },
    {
      tooltip: $localize`Restart`,
      action: (download: Download) => this.restartDownload(download),
      show: (download: Download) => download.finished,
      icon: 'restart_alt'
    },
    {
      tooltip: $localize`Pause`,
      action: (download: Download) => this.pauseDownload(download),
      show: (download: Download) => !download.finished && (!download.paused || !download.finished_step),
      icon: 'pause'
    },
    {
      tooltip: $localize`Resume`,
      action: (download: Download) => this.resumeDownload(download),
      show: (download: Download) => !download.finished && download.paused && download.finished_step,
      icon: 'play_arrow'
    },
    {
      tooltip: $localize`Cancel`,
      action: (download: Download) => this.cancelDownload(download),
      show: (download: Download) => !download.finished && !download.paused && !download.cancelled,
      icon: 'cancel'
    },
    {
      tooltip: $localize`Clear`,
      action: (download: Download) => this.clearDownload(download),
      show: (download: Download) => download.finished || download.paused,
      icon: 'delete'
    }
  ]

  downloads_retrieved = false;

  innerWidth: number;

  @ViewChild(MatPaginator) paginator: MatPaginator;
  @ViewChild(MatSort) sort: MatSort;

  @HostListener('window:resize', ['$event'])
  onResize(): void {
    this.innerWidth = window.innerWidth;
    this.recalculateColumns();
  }

  sort_downloads = (a: Download, b: Download): number => {
    const result = b.timestamp_start - a.timestamp_start;
    return result;
  }

  constructor(public postsService: PostsService, private router: Router, private dialog: MatDialog, private clipboard: Clipboard) { }

  ngOnInit(): void {
    // Remove sub name as it's not necessary for one-off downloads
    if (this.uids) this.displayedColumnsBig = this.displayedColumnsBig.filter(col => col !== 'sub_name');
    this.innerWidth = window.innerWidth;
    this.recalculateColumns();
    if (this.postsService.initialized) {
      this.getCurrentDownloadsRecurring();
    } else {
      this.postsService.service_initialized.subscribe(init => {
        if (init) {
          this.getCurrentDownloadsRecurring();
        }
      });
    }
  }

  getCurrentDownloadsRecurring(): void {
    if (!this.postsService.config['Extra']['enable_downloads_manager']) {
      this.router.navigate(['/home']);
      return;
    }
    this.getCurrentDownloads();
    this.interval_id = setInterval(() => {
      this.getCurrentDownloads();
    }, this.downloads_check_interval);
  }

  ngOnDestroy(): void {
    if (this.interval_id) { clearInterval(this.interval_id) }
  }

  getCurrentDownloads(): void {
    this.postsService.getCurrentDownloads(this.uids).subscribe(res => {
      // In filtered mode (the home page) the backend also returns downloads
      // started elsewhere - the capture extension, the API - while they are
      // active. Adopt their uids so they stay listed after they finish, the same
      // way a download started from this page does. Without this they vanish the
      // instant they complete and look like they never appeared.
      if (this.uids && res['downloads']) {
        for (const download of res['downloads']) {
          if (!this.uids.includes(download['uid'])) this.uids.push(download['uid']);
        }
      }
      if (res['downloads'] !== null
        && res['downloads'] !== undefined
        && JSON.stringify(this.downloads) !== JSON.stringify(res['downloads'])) {
          this.downloads = this.combineDownloads(this.downloads, res['downloads']);
          // this.downloads = res['downloads'];
          this.downloads.sort(this.sort_downloads);
          this.dataSource = new MatTableDataSource<Download>(this.downloads);
          this.dataSource.paginator = this.paginator;
          this.dataSource.sort = this.sort;
          this.paused_download_exists = this.downloads.find(download => download['paused'] && !download['error']);
          this.running_download_exists = this.downloads.find(download => !download['paused'] && !download['finished']);
      } else {
        // failed to get downloads
      }
      this.downloads_retrieved = true;
    });
  }

  // Dispatches on what the backend is asking for. Both prompts reuse the shared
  // confirm dialog: an extension warning is a text confirmation, and picking a
  // detected candidate is a selection list.
  reviewPendingDownload(download: Download): void {
    const confirmation = download['pending_confirmation'];
    if (!confirmation) return;

    if (confirmation.kind === 'unsafe_extension') {
      this.confirmUnsafeExtension(download, confirmation);
    } else if (confirmation.kind === 'candidate_selection') {
      this.chooseDetectedCandidate(download, confirmation);
    }
  }

  private confirmUnsafeExtension(download: Download, confirmation: any): void {
    // The extension is whatever yt-dlp itself reported refusing, and the
    // content type is what the server actually returned - both are shown so the
    // decision is evidence-based rather than a blind "allow?".
    const lines = [
      $localize`yt-dlp refused to save this download because the file extension is unusual.`,
      '',
      $localize`Extension it wants to write: .${confirmation.extension}`,
      confirmation.content_type
        ? $localize`The server reports this file as: ${confirmation.content_type}`
        : $localize`The server did not report a content type.`,
      confirmation.server_says_media
        ? $localize`That content type is a media type, so this is most likely a genuine video served from an unusual URL.`
        : $localize`That is not a recognised media type, so treat this with more caution.`,
      '',
      $localize`URL: ${confirmation.url}`,
      '',
      $localize`Allowing this adds --compat-options allow-unsafe-ext for this download only. This safety check exists to stop dangerous file extensions being written to disk, so only allow it if you recognise the source.`
    ];

    const doneEmitter = new EventEmitter<boolean>();
    const dialogRef = this.dialog.open(ConfirmDialogComponent, {
      data: {
        dialogType: 'text',
        dialogTitle: $localize`Unusual file extension`,
        dialogText: lines.join('\n'),
        submitText: $localize`Allow and download`,
        cancelText: $localize`Cancel download`,
        warnSubmitColor: true,
        doneEmitter: doneEmitter
      }
    });
    doneEmitter.subscribe((done: boolean) => {
      if (done) this.sendConfirmation(download, true, null, dialogRef);
    });
  }

  private chooseDetectedCandidate(download: Download, confirmation: any): void {
    const doneEmitter = new EventEmitter<boolean>();
    const dialogRef = this.dialog.open(ConfirmDialogComponent, {
      data: {
        dialogType: 'selection_list',
        dialogTitle: $localize`Choose which video to download`,
        dialogText: $localize`yt-dlp could not handle this page, but ${confirmation.candidates.length} possible media URLs were found on it. Pick the one you want.`,
        submitText: $localize`Download selected`,
        doneEmitter: doneEmitter,
        list: confirmation.candidates.map(candidate => ({
          key: candidate.url,
          title: this.describeCandidate(candidate)
        }))
      }
    });
    doneEmitter.subscribe((done: boolean) => {
      if (!done) return;
      const selected = dialogRef.componentInstance.selected_items;
      if (!selected || selected.length === 0) return;
      // The dialog is a multi-select; only one candidate can be downloaded here.
      this.sendConfirmation(download, true, selected[0], dialogRef);
    });
  }

  private describeCandidate(candidate: any): string {
    const parts = [];
    if (candidate.content_type) parts.push(candidate.content_type);
    if (candidate.content_length) parts.push(`${(candidate.content_length / 1048576).toFixed(1)} MB`);
    parts.push($localize`found in ${candidate.found_in}`);
    if (candidate.needs_confirmation_for_extension) parts.push($localize`unusual extension`);
    // The URL matters most here - two candidates often differ only by filename.
    return `${candidate.url}  —  ${parts.join(', ')}`;
  }

  private sendConfirmation(download: Download, approve: boolean, candidate_url: string, dialogRef = null): void {
    this.postsService.confirmPendingDownload(download['uid'], approve, candidate_url).subscribe(res => {
      if (res && res.success) {
        this.postsService.openSnackBar(approve ? $localize`Download resumed.` : $localize`Download cancelled.`);
        if (dialogRef) dialogRef.close();
        this.getCurrentDownloads();
      } else {
        this.postsService.openSnackBar((res && res.error) || $localize`Could not update the download.`);
      }
    }, () => {
      this.postsService.openSnackBar($localize`Could not update the download.`);
    });
  }

  clearDownloadsByType(): void {
    const clearEmitter = new EventEmitter<boolean>();
    const dialogRef = this.dialog.open(ConfirmDialogComponent, {
      data: {
        dialogType: 'selection_list',
        dialogTitle: $localize`Clear downloads`,
        dialogText: $localize`Select downloads to clear`,
        submitText: $localize`Clear`,
        doneEmitter: clearEmitter,
        warnSubmitColor: true,
        list: [
          {
            title: $localize`Finished downloads`,
            key: 'clear_finished'
          },
          {
            title: $localize`Paused downloads`,
            key: 'clear_paused'
          },
          {
            title: $localize`Errored downloads`,
            key: 'clear_errors'
          }
        ]
      }
    });
    clearEmitter.subscribe((done: boolean) => {
      if (done) {
        const selected_items = dialogRef.componentInstance.selected_items;
        this.postsService.clearDownloads(selected_items.includes('clear_finished'), selected_items.includes('clear_paused'), selected_items.includes('clear_errors')).subscribe(res => {
          if (!res['success']) {
            this.postsService.openSnackBar($localize`Failed to clear finished downloads!`);
          } else {
            this.postsService.openSnackBar($localize`Cleared downloads!`);
            dialogRef.close();
          }
        });
      }
    });
  }

  pauseDownload(download: Download): void {
    this.postsService.pauseDownload(download['uid']).subscribe(res => {
      if (!res['success']) {
        this.postsService.openSnackBar($localize`Failed to pause download! See server logs for more info.`);
      }
    });
  }

  pauseAllDownloads(): void {
    this.postsService.pauseAllDownloads().subscribe(res => {
      if (!res['success']) {
        this.postsService.openSnackBar($localize`Failed to pause all downloads! See server logs for more info.`);
      }
    });
  }

  resumeDownload(download: Download): void {
    this.postsService.resumeDownload(download['uid']).subscribe(res => {
      if (!res['success']) {
        this.postsService.openSnackBar($localize`Failed to resume download! See server logs for more info.`);
      }
    });
  }

  resumeAllDownloads(): void {
    this.postsService.resumeAllDownloads().subscribe(res => {
      if (!res['success']) {
        this.postsService.openSnackBar($localize`Failed to resume all downloads! See server logs for more info.`);
      }
    });
  }

  restartDownload(download: Download): void {
    this.postsService.restartDownload(download['uid']).subscribe(res => {
      if (!res['success']) {
        this.postsService.openSnackBar($localize`Failed to restart download! See server logs for more info.`);
      } else {
        if (this.uids && res['new_download_uid']) {
          this.uids.push(res['new_download_uid']);
        }
      }
    });
  }

  cancelDownload(download: Download): void {
    this.postsService.cancelDownload(download['uid']).subscribe(res => {
      if (!res['success']) {
        this.postsService.openSnackBar($localize`Failed to cancel download! See server logs for more info.`);
      }
    });
  }

  clearDownload(download: Download): void {
    this.postsService.clearDownload(download['uid']).subscribe(res => {
      if (!res['success']) {
        this.postsService.openSnackBar($localize`Failed to pause download! See server logs for more info.`);
      }
    });
  }

  watchContent(download: Download): void {
    const container = download['container'];
    localStorage.setItem('player_navigator', this.router.url.split(';')[0]);
    const is_playlist = container['uids']; // hacky, TODO: fix
    if (is_playlist) {
      this.router.navigate(['/player', {playlist_id: container['id'], type: download['type']}]);
    } else {
      this.router.navigate(['/player', {type: download['type'], uid: container['uid']}]);
    }
  }

  combineDownloads(downloads_old: Download[], downloads_new: Download[]): Download[] {
    // only keeps downloads that exist in the new set
    downloads_old = downloads_old.filter(download_old => downloads_new.some(download_new => download_new.uid === download_old.uid));

    // add downloads from the new set that the old one doesn't have
    const downloads_to_add = downloads_new.filter(download_new => !downloads_old.some(download_old => download_new.uid === download_old.uid));
    downloads_old.push(...downloads_to_add);
    downloads_old.forEach(download_old => {
      const download_new = downloads_new.find(download_to_check => download_old.uid === download_to_check.uid);
      Object.keys(download_new).forEach(key => {
        download_old[key] = download_new[key];
      });
  
      Object.keys(download_old).forEach(key => {
        if (!download_new[key]) delete download_old[key];
      });
    });

    return downloads_old;
  }

  showError(download: Download): void {
    console.log(download)
    const copyToClipboardEmitter = new EventEmitter<boolean>();
    this.dialog.open(ConfirmDialogComponent, {
      data: {
        dialogTitle: $localize`Error for ${download['url']}:url:`,
        dialogText: download['error'],
        submitText: $localize`Copy to clipboard`,
        cancelText: $localize`Close`,
        closeOnSubmit: false,
        onlyEmitOnDone: true,
        doneEmitter: copyToClipboardEmitter
      }
    });
    copyToClipboardEmitter.subscribe(done => {
      if (done) {
        this.postsService.openSnackBar($localize`Copied to clipboard!`);
        this.clipboard.copy(download['error']);
      }
    });
  }

  recalculateColumns() {
    if (this.innerWidth < 650) this.displayedColumns = this.displayedColumnsSmall;
    else                       this.displayedColumns = this.displayedColumnsBig;

    this.actionsFlex = this.uids || this.innerWidth < 800 ? 1 : 2;

    if (this.innerWidth < 800 && !this.uids || this.innerWidth < 1100 && this.uids) this.minimizeButtons = true;
    else                                                                            this.minimizeButtons = false;
  }
}

interface DownloadAction {
  tooltip: string,
  action: (download: Download) => void,
  show: (download: Download) => boolean,
  icon: string,
  loading?: (download: Download) => boolean
}