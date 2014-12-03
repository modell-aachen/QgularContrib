#!/usr/bin/perl -w
use strict;

BEGIN { unshift @INC, split( /:/, $ENV{FOSWIKI_LIBS} ); }

use Foswiki::Contrib::Build;

my $build = new Foswiki::Contrib::Build('QgularContrib');
$build->build( $build->{target} );

