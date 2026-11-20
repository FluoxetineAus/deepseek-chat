// 离屏渲染 HTML 并截图，用于验证真实外观
// clang -fobjc-arc -O2 shot.m -o shot -framework Cocoa -framework WebKit
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

@interface Shot : NSObject <WKNavigationDelegate>
@property (nonatomic, strong) WKWebView *web;
@property (nonatomic, copy) NSString *outPath;
@property (nonatomic, assign) CGFloat w;
@property (nonatomic, assign) CGFloat h;
@property (nonatomic, assign) double waitMs;
@end

@implementation Shot

- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation {
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)((self.waitMs / 1000.0) * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        WKSnapshotConfiguration *cfg = [WKSnapshotConfiguration new];
        cfg.rect = CGRectMake(0, 0, self.w, self.h);
        [webView takeSnapshotWithConfiguration:cfg completionHandler:^(NSImage *image, NSError *error) {
            if (!image) {
                fprintf(stderr, "snapshot failed: %s\n", error.description.UTF8String);
                exit(3);
            }
            NSBitmapImageRep *rep = [NSBitmapImageRep imageRepWithData:image.TIFFRepresentation];
            NSData *png = [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
            if (![png writeToFile:self.outPath atomically:YES]) {
                fprintf(stderr, "write failed\n");
                exit(4);
            }
            printf("wrote %s %ldx%ld\n", self.outPath.UTF8String,
                   (long)rep.pixelsWide, (long)rep.pixelsHigh);
            exit(0);
        }];
    });
}

- (void)webView:(WKWebView *)webView didFailNavigation:(WKNavigation *)navigation withError:(NSError *)error {
    fprintf(stderr, "load failed: %s\n", error.description.UTF8String);
    exit(5);
}

@end

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc < 5) {
            fprintf(stderr, "usage: shot <url> <out.png> <w> <h> [waitMs]\n");
            return 1;
        }
        [NSApplication sharedApplication];
        [[NSApplication sharedApplication] setActivationPolicy:NSApplicationActivationPolicyAccessory];

        Shot *s = [Shot new];
        s.outPath = [NSString stringWithUTF8String:argv[2]];
        s.w = atof(argv[3]);
        s.h = atof(argv[4]);
        s.waitMs = argc >= 6 ? atof(argv[5]) : 1000;

        NSWindow *win = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, s.w, s.h)
                                                    styleMask:NSWindowStyleMaskBorderless
                                                      backing:NSBackingStoreBuffered
                                                        defer:NO];
        WKWebView *web = [[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, s.w, s.h)];
        s.web = web;
        web.navigationDelegate = s;
        win.contentView = web;
        [win orderFront:nil];

        NSString *target = [NSString stringWithUTF8String:argv[1]];
        if ([target hasPrefix:@"http://"] || [target hasPrefix:@"https://"]) {
            [web loadRequest:[NSURLRequest requestWithURL:[NSURL URLWithString:target]]];
        } else {
            NSURL *u = [NSURL fileURLWithPath:target];
            [web loadFileURL:u allowingReadAccessToURL:[u URLByDeletingLastPathComponent]];
        }

        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(15 * NSEC_PER_SEC)),
                       dispatch_get_main_queue(), ^{
            fprintf(stderr, "timeout\n");
            exit(2);
        });
        [[NSApplication sharedApplication] run];
    }
    return 0;
}
